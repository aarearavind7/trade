"""Spreadsheet-friendly CSVs of broker records, without spreadsheet formulas."""
import csv
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from io import StringIO

from fastapi.responses import Response


def text(value):
    value = '' if value is None else str(value)
    return "'" + value if value.lstrip().startswith(('=', '+', '-', '@')) or value.startswith(('\t', '\r', '\n')) else value


def numeric(value):
    if value is None or value == '':
        return ''
    try:
        number = Decimal(str(value))
        return str(number) if number.is_finite() else ''
    except InvalidOperation:
        return ''


def csv_response(filename, headers, rows):
    output = StringIO(newline='')
    writer = csv.writer(output)
    writer.writerow(headers)
    writer.writerows(rows)
    return Response(('\ufeff' + output.getvalue()).encode('utf-8'), media_type='text/csv; charset=utf-8',
                    headers={'Content-Disposition': f'attachment; filename="{filename}"'})


def trades_csv(fills, complete):
    rows = []
    for fill in sorted(fills, key=lambda f: (f['transaction_time'], f['id']), reverse=True):
        qty, price = numeric(fill.get('qty')), numeric(fill.get('price'))
        value = str(Decimal(qty) * Decimal(price)) if qty and price else ''
        rows.append([text(fill.get(key)) for key in ('id', 'order_id', 'transaction_time', 'symbol', 'side')] +
                    [qty, price, value, 'USD', str(complete).lower()])
    return csv_response('trade-history.csv', ['fill_id', 'order_id', 'timestamp', 'symbol', 'side', 'quantity',
                        'fill_price_usd', 'value_usd', 'currency', 'fill_history_complete'], rows)


def performance_csv(data):
    history = data.get('portfolio_history') or {}
    rows = []
    for index, stamp in enumerate(history.get('timestamp') or []):
        try:
            timestamp = datetime.fromtimestamp(float(stamp), timezone.utc).isoformat()
        except (ValueError, TypeError, OverflowError, OSError):
            continue
        def at(key):
            values = history.get(key) or []
            return numeric(values[index]) if index < len(values) else ''
        rows.append([timestamp, at('equity'), at('profit_loss'), at('profit_loss_pct'),
                     numeric(history.get('base_value')), 'USD', text(history.get('timeframe')),
                     numeric(data.get('realized_pl')) if data.get('realized_complete') else '',
                     numeric(data.get('unrealized_pl')), data.get('fill_count', 0),
                     str(bool(data.get('realized_complete'))).lower(), text(data.get('since')), text(data.get('method'))])
    return csv_response('portfolio-performance.csv', ['timestamp_utc', 'equity_usd', 'broker_profit_loss_usd',
                        'broker_profit_loss_ratio', 'base_value_usd', 'currency', 'timeframe',
                        'current_realized_pl_usd', 'current_unrealized_pl_usd', 'fill_count',
                        'realized_complete', 'fills_since', 'calculation_method'], rows)
