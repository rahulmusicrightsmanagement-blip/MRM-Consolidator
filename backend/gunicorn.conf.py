# Gunicorn settings for the Docker image; each can be overridden with the MRM_* env vars below.
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8010')}"
workers = int(os.environ.get('MRM_WORKERS', '3'))
threads = int(os.environ.get('MRM_THREADS', '2'))
# Large IPRS / master spreadsheets can take a while to process.
timeout = int(os.environ.get('MRM_TIMEOUT', '300'))
graceful_timeout = 30
accesslog = '-'
errorlog = '-'
