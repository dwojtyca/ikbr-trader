FROM node:24-bookworm-slim

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
COPY apps/execution-engine/python/ /tmp/ibkr-sdk-build/
RUN python3 /tmp/ibkr-sdk-build/install_sdk.py /opt/ibkr-sdk-source \
    && python3 -m venv /opt/ikbr-sdk \
    && /opt/ikbr-sdk/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/ibkr-sdk-build/requirements.txt \
    && /opt/ikbr-sdk/bin/python -c "import site,pathlib; pathlib.Path(site.getsitepackages()[0], 'ibkr-official.pth').write_text('/opt/ibkr-sdk-source/IBJts/source/pythonclient\n')" \
    && /opt/ikbr-sdk/bin/python -I -c "import ibapi,google.protobuf; assert ibapi.__version__ == '1051.1'; assert google.protobuf.__version__ == '5.29.5'" \
    && /opt/ikbr-sdk/bin/python -I -m unittest discover -s /tmp/ibkr-sdk-build/ -v

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/ingestion/package.json apps/ingestion/package.json
COPY apps/signal-engine/package.json apps/signal-engine/package.json
COPY apps/execution-engine/package.json apps/execution-engine/package.json
COPY apps/llm-agent/package.json apps/llm-agent/package.json
COPY apps/backtest-engine/package.json apps/backtest-engine/package.json
COPY apps/ui/package.json apps/ui/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY tools/paper-verify-stack/package.json tools/paper-verify-stack/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm -r build
