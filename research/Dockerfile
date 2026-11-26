# Research environment for NEONFX: Python with the usual data and machine-learning libraries.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir numpy==2.* pandas==2.* lightgbm==4.* scikit-learn==1.*
WORKDIR /work
