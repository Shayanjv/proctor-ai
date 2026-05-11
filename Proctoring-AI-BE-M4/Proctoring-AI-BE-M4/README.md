# Proctoring AI System

A real-time AI proctoring system that monitors exam sessions using computer vision. The system detects suspicious activities and provides exam analytics through a secure WebSocket connection.

## Features

- **Real-time Detection**
  - Face presence/absence detection
  - Eye and mouth movement tracking
  - Hand gesture detection
  - Phone and multiple person detection

- **Authentication & Security**
  - JWT-based authentication
  - Face recognition login
  - Secure WebSocket connections
  - Session management

- **Exam Management**
  - Start/Stop exam sessions
  - Real-time activity logging
  - Session analytics
  - Compliance scoring

## Technical Stack

- **Backend Framework**: FastAPI
- **Database**: MySQL
- **ML/CV Libraries**:
  - MediaPipe (Face, Hand, Mesh detection)
  - YOLOv8 (Object detection)
  - OpenCV
  - face_recognition

## API Endpoints

### Authentication
- `POST /api/v1/auth/signup` - Register new user with face image
- `POST /api/v1/auth/login/password` - Login with email/password
- `POST /api/v1/auth/login/face` - Login with face recognition

### Exam Management
- `POST /api/v1/exam/start/{user_id}` - Start exam session
- `POST /api/v1/exam/stop/{user_id}` - Stop exam session
- `POST /api/v1/exam/pause/{user_id}` - Pause exam session
- `POST /api/v1/exam/resume/{user_id}` - Resume exam session
- `GET /api/v1/exam/summary/{user_id}` - Get exam analytics
- `POST /api/v1/exam/clear-logs/{user_id}` - Clear session logs

### WebSocket
- `ws://localhost:8080/ws/{user_id}` - Real-time proctoring connection

## Setup

### Using Docker (Recommended)

#### First-time setup

Fill in `.env` (POSTGRES_*, MINIO_*, CORS_ORIGINS, SEED_*) then bring up the
full stack:

```bash
docker compose up --build -d
```

This starts the web service on **localhost:8080** plus Postgres, MinIO, and
Redis. Persistent data is stored in named Docker volumes so you can stop and
start without losing anything.

#### Day-2 operations on a long-lived deployment

For an existing container named `proctoring-backend` (the default image
target), use the helper scripts in `scripts/` to apply changes without
disturbing the data volumes:

| When you change …                            | Run                                  | Approx. downtime |
| -------------------------------------------- | ------------------------------------ | ---------------- |
| Any `*.py` file                              | `./scripts/reload-backend.ps1`       | ~5–8 s (gunicorn SIGHUP) |
| `Dockerfile`, `requirements.txt`, or env     | `./scripts/redeploy-backend.ps1`     | ~30–60 s (rebuild + recreate) |

Both scripts default to `proctoring-backend`; pass `-ContainerName <name>` to
target a different container (e.g. the compose-managed `proctoring-ai-web-1`).
The redeploy script preserves env vars, network, mounts, and **never** touches
volumes — your DB and evidence are safe across rebuilds.

> **Why hot-reload works:** the Dockerfile launches gunicorn **without
> `--preload`**, so each worker imports the app independently. SIGHUP from
> `reload-backend.ps1` re-forks workers and they pick up the latest code from
> the bind-mounted `/app`. If you ever add `--preload` back to the gunicorn
> CMD, you must use `redeploy-backend.ps1` for every code change.

#### Troubleshooting the Docker daemon

If you see "Cannot connect to the Docker daemon":

1. Ensure Docker Desktop is installed and running.
2. On macOS, start it from the terminal:
   ```bash
   open -a Docker
   # wait ~30 s for Docker to come up, then retry the compose command
   ```
3. Verify the daemon is reachable:
   ```bash
   docker info
   ```

### Manual Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/Proctoring-AI-BE.git
cd Proctoring-AI-BE
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Set up MySQL database:
```sql
CREATE DATABASE Proctoring_AI;
```

4. Configure environment:
```bash
# Update database URL in config/database.py if needed
SQLALCHEMY_DATABASE_URL = "mysql+mysqlconnector://user:password@localhost/Proctoring_AI"
```

5. Start the server:
```bash
uvicorn main:app --host localhost --port 8080 --reload
```

## API Documentation

A complete Postman collection is available at:
```bash
/postman_collection/Proctoring AI - Sharath.postman_collection.json
```

Import this collection into Postman to test all available endpoints:
1. Open Postman
2. Click "Import"
3. Select the collection JSON file
4. All endpoints will be available with example requests

The collection includes:
- Authentication endpoints (signup, login)
- Exam management endpoints
- WebSocket testing examples
- Environment variables

## Architecture

- `detection/` - ML model implementations
- `models/` - Database models
- `routers/` - API routes
- `schemas/` - Pydantic models
- `services/` - Business logic
- `utils/` - Helper functions

## WebSocket Protocol

### Client -> Server:
- Video frames as base64 or binary data

### Server -> Client:
```json
{
  "type": "logs",
  "data": [
    {
      "event": "Face not detected",
      "time": "2025-03-22T12:20:14.075"
    }
  ],
  "stored": true
}
```

## License

MIT License
