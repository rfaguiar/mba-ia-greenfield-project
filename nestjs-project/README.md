# StreamTube API

NestJS backend for StreamTube authentication, channel ownership, and video uploads and processing.

## Run locally

Use Docker Compose from this directory. Copy `.env.example` to `.env` and adjust credentials before starting the stack:

```bash
docker compose up -d
docker compose exec nestjs-api npm install
docker compose exec nestjs-api npm run migration:run
```

The Compose stack includes the NestJS API container, PostgreSQL, Mailpit, MinIO, an S3 CORS proxy, RabbitMQ, and the FFmpeg worker. `docker compose up -d` starts the worker alongside the backend. Start the API listener in watch mode with the command below; it is then available at `http://localhost:3000`. S3 is available at `http://localhost:9000`, MinIO's console at `http://localhost:9001`, RabbitMQ management at `http://localhost:15672`, and Mailpit at `http://localhost:8025`.

For iterative development, start the API in watch mode with `docker compose exec nestjs-api npm run start:dev`. To run a second worker manually, use `docker compose exec worker npm run start:worker:dev`.

## Video upload flow

1. Authenticate and start a multipart upload with `POST /channels/:channelId/videos`.
2. Upload each part directly to its returned presigned URL. Use `GET /channels/:channelId/videos/:videoId/uploads/parts` to resume.
3. Call `POST /channels/:channelId/videos/:videoId/uploads/complete`. The API verifies part numbers and sizes before publishing a job.
4. The RabbitMQ worker probes the media, creates a thumbnail, and transitions the video to `ready`; failed attempts are retried or marked with a terminal error.
5. Public metadata, stream, download, and thumbnail routes are available under `/videos/:id` only for ready videos.

The original filename is metadata only; storage object keys use internal identifiers. Upload, processing, and public media behavior is configured through the storage, queue, and worker environment variables in `.env.example`.

## Tests and checks

Run commands inside the API container:

```bash
docker compose exec -e DB_DATABASE=streamtube_test -e DB_NAME=streamtube_test nestjs-api npm test -- --runInBand
docker compose exec -e DB_DATABASE=streamtube_test -e DB_NAME=streamtube_test nestjs-api npm run test:e2e
docker compose exec nestjs-api npx tsc --noEmit
docker compose exec nestjs-api npm run lint
```

Create the dedicated `streamtube_test` database before running the test commands. Integration and E2E tests clear tables in their configured database, so never point `DB_DATABASE` or `DB_NAME` at a development database. Tests must run serially because they share database state. The broker-to-worker integration test also starts the standalone worker process and requires the Compose FFmpeg image.
