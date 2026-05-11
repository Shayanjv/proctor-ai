# Use a stable Debian base to reduce apt flakiness
FROM python:3.9-slim-bookworm

# Set working directory
ENV PYTHONUNBUFFERED=1

WORKDIR /app
ENV HOME=/root
RUN mkdir -p /root/.deepface

# Install system dependencies (required for OpenCV)
# Add retries to reduce intermittent network failures during builds.
RUN apt-get update -o Acquire::Retries=5 && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    libopenblas-dev \
    liblapack-dev \
    libglib2.0-0 \
    libgl1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first to leverage Docker cache


# Install python dependencies
# Install heavy dependencies first (Torch, TensorFlow) to use caching and prevent timeouts
RUN pip install --no-cache-dir --default-timeout=1000 --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple torch>=2.0.1 torchvision>=0.15.2

RUN pip install --no-cache-dir --default-timeout=1000 tensorflow-cpu==2.15.0 tf-keras==2.15.0 keras>=2.15.0

# Install deepface and retina-face without their dependencies (to avoid hash mismatch issues)
RUN pip install --no-cache-dir --default-timeout=1000 --no-deps deepface==0.0.79 retina-face>=0.0.13

# DeepFace runtime requires `fire` in some code paths; install explicitly since we used --no-deps above.
RUN pip install --no-cache-dir fire

# Install remaining python dependencies
# Copy requirements file (now, so heavy deps above are cached)
COPY requirements.txt .
RUN pip install --no-cache-dir --default-timeout=1000 -r requirements.txt

# Copy the rest of the application
COPY . .

# Pre-download heavy DeepFace weights at build time so runtime requests never block
# and gunicorn workers don't race to download the same file.
#
# We download explicitly with retries + size check, because partial downloads
# cause DeepFace/Keras to crash with "truncated file" errors.
RUN mkdir -p /root/.deepface/weights \
    && rm -f /root/.deepface/weights/vgg_face_weights.h5 \
    && curl -L --retry 10 --retry-all-errors --connect-timeout 30 \
         -o /root/.deepface/weights/vgg_face_weights.h5 \
         https://github.com/serengil/deepface_models/releases/download/v1.0/vgg_face_weights.h5 \
    && python -c "import os; p='/root/.deepface/weights/vgg_face_weights.h5'; s=os.path.getsize(p); assert s>550_000_000, f'weights too small: {s} bytes'; print('DeepFace weights downloaded:', s, 'bytes')" \
    && python -c "from deepface import DeepFace; DeepFace.build_model('VGG-Face'); print('DeepFace VGG-Face model ready')"

# Expose port
EXPOSE 8000

# Command to run the application using Gunicorn (Production)
# We use uvicorn worker class for FastAPI.
#
# IMPORTANT: the ML stack (YOLOv8 / PyTorch / MediaPipe / DeepFace) does not
# behave well with gunicorn's --preload flag: models are initialised in the
# master process, then every fork()-ed worker inherits half-initialised CUDA /
# OpenCV state. Combined with --timeout 300 that was SIGKILL-ing workers in
# the middle of long inference bursts, producing periodic 5–10 s periods
# where HTTP requests hang while a new worker boots and re-loads ~500 MB of
# model weights.
#
# The fixes:
#   -w 1             Single worker → no fork-after-ML-init, predictable memory
#                    footprint. Set WEB_CONCURRENCY=N to scale when you know
#                    the host has headroom (each worker is ~2–3 GB).
#   (no --preload)   Each worker loads models cleanly in its own process.
#   --timeout 0      Disable the request-watchdog that was killing healthy
#                    workers during long (but legitimate) ML inference. The
#                    graceful-shutdown path still works on container stop.
#   --graceful-timeout 30  Unchanged; only applies during deliberate restarts.
CMD ["/bin/sh", "-c", "gunicorn -w ${WEB_CONCURRENCY:-1} --timeout 0 --graceful-timeout 30 -k uvicorn.workers.UvicornWorker main:app --bind 0.0.0.0:8000"]