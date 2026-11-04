// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! openvoxa-audio: records one program's sound on Windows 10 2004 or
//! later, for OpenVoxa's window shares (decisions.md, "Per-app share
//! sound").
//!
//! Usage: `openvoxa-audio --window <HWND>` or `--pid <PID>`, optionally
//! `--exclude` (everything except that program instead).
//!
//! It records the sound of the program that owns the window together
//! with every program it started (Windows' "process loopback"), and
//! writes it to stdout as raw PCM: 48 kHz, stereo, 16-bit signed little
//! endian, interleaved. Windows keeps delivering (silent) packets while
//! the program makes no sound, so the stream is steady (WH3, a terminal
//! window: 7.98 s of 8 received).
//!
//! stderr carries one line when recording starts,
//! `ok pid=<PID> exe=<name> format=s16le rate=48000 channels=2`,
//! or `error: <reason>` before a non-zero exit. The helper exits when
//! its stdin closes, so it never outlives the app that started it.

#[cfg(not(windows))]
fn main() {
    eprintln!("error: openvoxa-audio only runs on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    if let Err(msg) = win::run() {
        eprintln!("error: {msg}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod win {
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::Duration;

    use windows::Win32::Foundation::{CloseHandle, HWND, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient,
        IAudioClient, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, IAgileObject, IAgileObject_Impl};
    use windows::Win32::System::Threading::{
        CreateEventW, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW, WaitForSingleObject,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    use windows::core::{IUnknown, Interface, PWSTR, w};
    use windows_core::{HRESULT, implement};

    const RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;
    const BYTES_PER_FRAME: u32 = 4; // 2 channels x 16 bits

    // The activation parameters, laid out by hand: the crate's PROPVARIANT
    // type changes between versions, the C layout does not.
    // AUDIOCLIENT_ACTIVATION_PARAMS with ActivationType = PROCESS_LOOPBACK.
    #[repr(C)]
    struct LoopbackParams {
        activation_type: u32, // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
        target_pid: u32,
        mode: u32, // 0 = include the process tree, 1 = exclude it
    }
    // PROPVARIANT holding a VT_BLOB (24 bytes on x64).
    #[repr(C)]
    struct BlobVariant {
        vt: u16,
        reserved: [u16; 3],
        size: u32,
        data: *const u8,
    }
    const VT_BLOB: u16 = 65;

    #[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
    struct Done(mpsc::Sender<()>);

    impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
        fn ActivateCompleted(
            &self,
            _op: windows_core::Ref<'_, IActivateAudioInterfaceAsyncOperation>,
        ) -> windows_core::Result<()> {
            let _ = self.0.send(());
            Ok(())
        }
    }

    // Agile: Windows may call it back on any thread.
    impl IAgileObject_Impl for Done_Impl {}

    struct Args {
        pid: u32,
        exclude: bool,
    }

    fn parse_args() -> Result<Args, String> {
        let mut args = std::env::args().skip(1);
        let mut pid = None;
        let mut exclude = false;
        while let Some(a) = args.next() {
            match a.as_str() {
                "--window" => {
                    let v = args.next().ok_or("--window needs a window handle")?;
                    let hwnd: isize = v.parse().map_err(|_| format!("bad window handle {v:?}"))?;
                    let mut p = 0u32;
                    unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut p)) };
                    if p == 0 {
                        return Err(format!("no window {hwnd} (closed?)"));
                    }
                    pid = Some(p);
                }
                "--pid" => {
                    let v = args.next().ok_or("--pid needs a process ID")?;
                    pid = Some(v.parse().map_err(|_| format!("bad process ID {v:?}"))?);
                }
                "--exclude" => exclude = true,
                _ => return Err(format!("unknown argument {a:?}")),
            }
        }
        Ok(Args { pid: pid.ok_or("give --window or --pid")?, exclude })
    }

    fn exe_name(pid: u32) -> String {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return "?".into();
            };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return "?".into();
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().unwrap_or(&path).to_string()
        }
    }

    fn activate(pid: u32, exclude: bool) -> Result<IAudioClient, String> {
        let params = LoopbackParams { activation_type: 1, target_pid: pid, mode: exclude as u32 };
        let variant = BlobVariant {
            vt: VT_BLOB,
            reserved: [0; 3],
            size: std::mem::size_of::<LoopbackParams>() as u32,
            data: &params as *const _ as *const u8,
        };
        let (tx, rx) = mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler = Done(tx).into();
        let op = unsafe {
            ActivateAudioInterfaceAsync(
                w!("VAD\\Process_Loopback"),
                &IAudioClient::IID,
                Some(&variant as *const _ as *const _),
                &handler,
            )
        }
        .map_err(|e| format!("this Windows can't record one program's sound (needs Windows 10 2004 or later): {e}"))?;
        rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "Windows didn't answer the recording request")?;
        let mut hr = HRESULT(0);
        let mut unk: Option<IUnknown> = None;
        unsafe { op.GetActivateResult(&mut hr, &mut unk) }.map_err(|e| format!("activation failed: {e}"))?;
        hr.ok().map_err(|e| format!("activation failed: {e}"))?;
        unk.ok_or("activation gave no audio client")?
            .cast::<IAudioClient>()
            .map_err(|e| format!("activation gave the wrong object: {e}"))
    }

    pub fn run() -> Result<(), String> {
        let args = parse_args()?;
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok().map_err(|e| format!("COM: {e}"))?;

        // Exit as soon as the app that started us closes our stdin or dies.
        std::thread::spawn(|| {
            let mut buf = [0u8; 64];
            let mut stdin = std::io::stdin();
            while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
            std::process::exit(0);
        });

        let client = activate(args.pid, args.exclude)?;
        let format = WAVEFORMATEX {
            wFormatTag: 1, // WAVE_FORMAT_PCM
            nChannels: CHANNELS,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * BYTES_PER_FRAME,
            nBlockAlign: BYTES_PER_FRAME as u16,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let capture: IAudioCaptureClient = unsafe {
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK
                        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    200_000, // 20 ms buffer, in 100 ns units
                    0,
                    &format,
                    None,
                )
                .map_err(|e| format!("audio setup failed: {e}"))?;
            let event = CreateEventW(None, false, false, None).map_err(|e| format!("event: {e}"))?;
            client.SetEventHandle(event).map_err(|e| format!("audio event: {e}"))?;
            let capture = client.GetService().map_err(|e| format!("audio capture: {e}"))?;
            client.Start().map_err(|e| format!("audio start: {e}"))?;
            eprintln!(
                "ok pid={} exe={} format=s16le rate={RATE} channels={CHANNELS}{}",
                args.pid,
                exe_name(args.pid),
                if args.exclude { " exclude" } else { "" }
            );
            loop {
                if WaitForSingleObject(event, 200) != WAIT_OBJECT_0 {
                    continue; // no packet yet
                }
                drain(&capture)?;
            }
        };
        #[allow(unreachable_code)]
        {
            let _ = capture;
            Ok(())
        }
    }

    unsafe fn drain(capture: &IAudioCaptureClient) -> Result<(), String> {
        let mut out = std::io::stdout().lock();
        loop {
            let frames = unsafe { capture.GetNextPacketSize() }.map_err(|e| format!("audio read: {e}"))?;
            if frames == 0 {
                break;
            }
            let mut data = std::ptr::null_mut();
            let mut n = 0u32;
            let mut flags = 0u32;
            unsafe { capture.GetBuffer(&mut data, &mut n, &mut flags, None, None) }
                .map_err(|e| format!("audio read: {e}"))?;
            let len = (n * BYTES_PER_FRAME) as usize;
            let res = if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                out.write_all(&vec![0u8; len])
            } else {
                out.write_all(unsafe { std::slice::from_raw_parts(data, len) })
            };
            unsafe { capture.ReleaseBuffer(n) }.map_err(|e| format!("audio read: {e}"))?;
            // The app went away: nothing left to do.
            if res.is_err() {
                std::process::exit(0);
            }
        }
        if out.flush().is_err() {
            std::process::exit(0);
        }
        Ok(())
    }
}
