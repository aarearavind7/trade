"""Command-line demo for the Alpaca paper-trading client."""

import argparse
import json
import sys
from typing import Optional, Sequence

from .alpaca_client import AlpacaClient, AlpacaError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Simple Alpaca paper-trading demo")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("account", help="show the paper account")

    price_parser = subparsers.add_parser("price", help="show the latest IEX trade")
    price_parser.add_argument("symbol", help="stock symbol, for example AAPL")

    order_parser = subparsers.add_parser("order", help="submit a paper order")
    order_parser.add_argument("symbol", help="stock symbol, for example AAPL")
    order_parser.add_argument("side", choices=["buy", "sell"])
    order_parser.add_argument("qty", type=float)
    order_parser.add_argument("--type", default="market", dest="order_type")
    order_parser.add_argument("--time-in-force", default="day")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        client = AlpacaClient()
        if args.command == "account":
            result = client.account()
        elif args.command == "price":
            result = client.latest_trade(args.symbol)
        else:
            result = client.submit_order(
                args.symbol,
                args.side,
                args.qty,
                order_type=args.order_type,
                time_in_force=args.time_in_force,
            )
        print(json.dumps(result, indent=2))
        return 0
    except (ValueError, AlpacaError) as exc:
        print("Error: {}".format(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

