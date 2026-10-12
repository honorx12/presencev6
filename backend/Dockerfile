FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt && pip install --no-deps face_recognition

COPY . .

# Host injects $PORT (Railway/Render/Fly/HF). 7860 fallback = Hugging Face Spaces.
CMD ["sh", "-c", "uvicorn api:app --host 0.0.0.0 --port ${PORT:-7860} --workers 1"]
