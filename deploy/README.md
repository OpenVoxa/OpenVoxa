# Deploying OpenVoxa

Local and homelab deployment. Not production-ready.

## First time

    git clone https://github.com/OpenVoxa/OpenVoxa.git
    cd OpenVoxa/deploy
    docker compose up -d --build

Check it came up:

    curl http://localhost:8080/health

## Updating after a code change

Push from your development machine first, then on the server:

    git pull
    docker compose up -d --build server

Hard-refresh the browser (Ctrl+Shift+R) if you changed anything
under debugui/.

## Troubleshooting

Changes not showing up? Check the chain in order:

1. Is the change saved on the dev machine?
2. Is it committed and pushed?
3. Did the server `git pull`?
4. Did the image rebuild? `docker compose up -d --build server`
5. Is the browser serving a cached page?

Logs:

    docker compose logs server --tail 50
