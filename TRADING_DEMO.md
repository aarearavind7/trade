# Alpaca paper-trading demo

This repository includes a small Python example under `trading_app/` for learning with Alpaca's paper-trading API. It is configured for paper trading by default, so it does not place real-money orders.

## Setup

1. Create a free Alpaca paper account and generate paper API keys.
2. From the repository root, create a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

The demo uses Python's standard library and has no third-party runtime dependencies. Copy `.env.example` to `.env`, replace the two placeholder values, and load it in the current terminal:

```bash
cp .env.example .env
set -a
source .env
set +a
```

Never commit `.env` or real API keys. The paper endpoint is `https://paper-api.alpaca.markets`.

## Run the demo

```bash
python -m trading_app.cli account
python -m trading_app.cli price AAPL
python -m trading_app.cli order AAPL buy 1
python -m trading_app.cli order AAPL sell 1
```

The order commands submit simulated orders only. Review the output and your Alpaca paper dashboard before changing any endpoint or using live credentials.

## Run tests

The demo tests use mocked responses, so they do not contact Alpaca:

```bash
python -m unittest discover -s trading_app/tests -v
```

The original repository validation tests remain under `scripts/tests/`.

