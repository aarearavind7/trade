FROM python:3.12-slim
WORKDIR /app
COPY trading_app/requirements.txt /app/trading_app/requirements.txt
RUN pip install --no-cache-dir -r trading_app/requirements.txt && useradd --create-home trader
COPY trading_app /app/trading_app
COPY web /app/web
RUN mkdir -p /app/trading_app/data && chown -R trader:trader /app
USER trader
EXPOSE 8000
CMD ["uvicorn", "trading_app.api:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
