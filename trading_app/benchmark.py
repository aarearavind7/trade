"""Compare observed equity with the S&P 500 price index on common sessions."""
from datetime import datetime
from zoneinfo import ZoneInfo
from .research import finite
from .service import TradeError


def comparison(history, index):
    def session(stamp):
        return datetime.fromtimestamp(float(stamp), ZoneInfo('America/New_York')).date().isoformat()
    portfolio, benchmark = {}, {}
    for stamp, value in zip(history.get('timestamp') or [], history.get('equity') or []):
        value = finite(value)
        if value is None or value <= 0:
            continue
        try:
            portfolio[session(stamp)] = value
        except (ValueError, TypeError, OverflowError, OSError):
            continue
    for row in index:
        value = finite(row.get('close'))
        if value is None or value <= 0:
            continue
        try:
            benchmark[session(row.get('timestamp'))] = value
        except (ValueError, TypeError, OverflowError, OSError):
            continue
    dates = sorted(portfolio.keys() & benchmark.keys())
    if len(dates) < 2:
        raise TradeError('At least two matching market sessions are needed to compare portfolio and S&P 500 history.', 422)
    first = dates[0]
    points = [{'date': day, 'portfolio_pct': (portfolio[day] / portfolio[first] - 1) * 100,
               'benchmark_pct': (benchmark[day] / benchmark[first] - 1) * 100} for day in dates]
    return {'points': points, 'start': first, 'end': dates[-1], 'portfolio_return_pct': points[-1]['portfolio_pct'],
            'benchmark_return_pct': points[-1]['benchmark_pct'], 'benchmark': 'S&P 500 price index (^GSPC)',
            'source': 'Yahoo Finance', 'matched_sessions': len(points),
            'note': 'Same common New York session dates, normalized to the first match. Portfolio equity change includes deposits, withdrawals and income; it is not a cash-flow-adjusted return. The S&P 500 price index excludes dividends. Public index data may be delayed.'}
