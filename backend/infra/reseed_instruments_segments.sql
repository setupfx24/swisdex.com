-- Re-seed instrument_segments + instruments after a DB wipe.
-- Tables already exist (only their rows were truncated). Idempotent.
BEGIN;
INSERT INTO instrument_segments (name, display_name) VALUES
    ('forex', 'Forex'),
    ('indices', 'Indices'),
    ('commodities', 'Commodities'),
    ('crypto', 'Cryptocurrency'),
    ('stocks', 'Stocks'),
    ('energies', 'Energies') ON CONFLICT (name) DO NOTHING;

INSERT INTO instruments (symbol, display_name, segment_id, base_currency, quote_currency, digits, pip_size) VALUES
    ('EURUSD', 'Euro / US Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'EUR', 'USD', 5, 0.0001),
    ('GBPUSD', 'British Pound / US Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'GBP', 'USD', 5, 0.0001),
    ('USDJPY', 'US Dollar / Japanese Yen', (SELECT id FROM instrument_segments WHERE name='forex'), 'USD', 'JPY', 3, 0.01),
    ('AUDUSD', 'Australian Dollar / US Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'AUD', 'USD', 5, 0.0001),
    ('USDCAD', 'US Dollar / Canadian Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'USD', 'CAD', 5, 0.0001),
    ('USDCHF', 'US Dollar / Swiss Franc', (SELECT id FROM instrument_segments WHERE name='forex'), 'USD', 'CHF', 5, 0.0001),
    ('NZDUSD', 'New Zealand Dollar / US Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'NZD', 'USD', 5, 0.0001),
    ('EURGBP', 'Euro / British Pound', (SELECT id FROM instrument_segments WHERE name='forex'), 'EUR', 'GBP', 5, 0.0001),
    ('EURJPY', 'Euro / Japanese Yen', (SELECT id FROM instrument_segments WHERE name='forex'), 'EUR', 'JPY', 3, 0.01),
    ('GBPJPY', 'British Pound / Japanese Yen', (SELECT id FROM instrument_segments WHERE name='forex'), 'GBP', 'JPY', 3, 0.01),
    ('XAUUSD', 'Gold / US Dollar', (SELECT id FROM instrument_segments WHERE name='commodities'), 'XAU', 'USD', 2, 0.01),
    ('XAGUSD', 'Silver / US Dollar', (SELECT id FROM instrument_segments WHERE name='commodities'), 'XAG', 'USD', 3, 0.001),
    ('USOIL', 'US Crude Oil (WTI)', (SELECT id FROM instrument_segments WHERE name='energies'), 'OIL', 'USD', 2, 0.01),
    ('US30', 'Dow Jones 30', (SELECT id FROM instrument_segments WHERE name='indices'), 'US30', 'USD', 1, 0.1),
    ('US500', 'S&P 500', (SELECT id FROM instrument_segments WHERE name='indices'), 'US500', 'USD', 1, 0.1),
    ('NAS100', 'NASDAQ 100', (SELECT id FROM instrument_segments WHERE name='indices'), 'NAS100', 'USD', 1, 0.1),
    ('BTCUSD', 'Bitcoin / US Dollar', (SELECT id FROM instrument_segments WHERE name='crypto'), 'BTC', 'USD', 2, 0.01),
    ('ETHUSD', 'Ethereum / US Dollar', (SELECT id FROM instrument_segments WHERE name='crypto'), 'ETH', 'USD', 2, 0.01),
    ('LTCUSD', 'Litecoin / US Dollar', (SELECT id FROM instrument_segments WHERE name='crypto'), 'LTC', 'USD', 2, 0.01),
    ('XRPUSD', 'Ripple / US Dollar', (SELECT id FROM instrument_segments WHERE name='crypto'), 'XRP', 'USD', 4, 0.0001),
    ('SOLUSD', 'Solana / US Dollar', (SELECT id FROM instrument_segments WHERE name='crypto'), 'SOL', 'USD', 2, 0.01),
    ('EURCHF', 'Euro / Swiss Franc', (SELECT id FROM instrument_segments WHERE name='forex'), 'EUR', 'CHF', 5, 0.0001),
    ('GBPCHF', 'British Pound / Swiss Franc', (SELECT id FROM instrument_segments WHERE name='forex'), 'GBP', 'CHF', 5, 0.0001),
    ('AUDJPY', 'Australian Dollar / Japanese Yen', (SELECT id FROM instrument_segments WHERE name='forex'), 'AUD', 'JPY', 3, 0.01),
    ('CADJPY', 'Canadian Dollar / Japanese Yen', (SELECT id FROM instrument_segments WHERE name='forex'), 'CAD', 'JPY', 3, 0.01),
    ('NZDJPY', 'New Zealand Dollar / Japanese Yen', (SELECT id FROM instrument_segments WHERE name='forex'), 'NZD', 'JPY', 3, 0.01),
    ('USDHKD', 'US Dollar / Hong Kong Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'USD', 'HKD', 5, 0.0001),
    ('UK100', 'FTSE 100', (SELECT id FROM instrument_segments WHERE name='indices'), 'UK100', 'GBP', 1, 0.1),
    ('GER40', 'DAX 40', (SELECT id FROM instrument_segments WHERE name='indices'), 'GER40', 'EUR', 1, 0.1),
    ('XPTUSD', 'Platinum / US Dollar', (SELECT id FROM instrument_segments WHERE name='commodities'), 'XPT', 'USD', 2, 0.01),
    ('NATGAS', 'Natural Gas', (SELECT id FROM instrument_segments WHERE name='energies'), 'NG', 'USD', 3, 0.001),
    ('UKOIL', 'Brent Crude Oil', (SELECT id FROM instrument_segments WHERE name='energies'), 'OIL', 'USD', 2, 0.01),
    ('BNBUSD', 'Binance Coin / US Dollar', (SELECT id FROM instrument_segments WHERE name='crypto'), 'BNB', 'USD', 2, 0.01),
    ('DOGEUSD', 'Dogecoin / US Dollar', (SELECT id FROM instrument_segments WHERE name='crypto'), 'DOGE', 'USD', 5, 0.00001),
    ('ADAUSD', 'Cardano / US Dollar', (SELECT id FROM instrument_segments WHERE name='crypto'), 'ADA', 'USD', 4, 0.0001),
    ('AUDCAD', 'Australian Dollar / Canadian Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'AUD', 'CAD', 5, 0.0001),
    ('AUDCHF', 'Australian Dollar / Swiss Franc', (SELECT id FROM instrument_segments WHERE name='forex'), 'AUD', 'CHF', 5, 0.0001),
    ('AUDNZD', 'Australian Dollar / NZ Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'AUD', 'NZD', 5, 0.0001),
    ('CADCHF', 'Canadian Dollar / Swiss Franc', (SELECT id FROM instrument_segments WHERE name='forex'), 'CAD', 'CHF', 5, 0.0001),
    ('CHFJPY', 'Swiss Franc / Japanese Yen', (SELECT id FROM instrument_segments WHERE name='forex'), 'CHF', 'JPY', 3, 0.01),
    ('EURAUD', 'Euro / Australian Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'EUR', 'AUD', 5, 0.0001),
    ('EURCAD', 'Euro / Canadian Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'EUR', 'CAD', 5, 0.0001),
    ('EURNZD', 'Euro / NZ Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'EUR', 'NZD', 5, 0.0001),
    ('GBPAUD', 'British Pound / Australian Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'GBP', 'AUD', 5, 0.0001),
    ('GBPCAD', 'British Pound / Canadian Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'GBP', 'CAD', 5, 0.0001),
    ('GBPNZD', 'British Pound / NZ Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'GBP', 'NZD', 5, 0.0001),
    ('NZDCAD', 'NZ Dollar / Canadian Dollar', (SELECT id FROM instrument_segments WHERE name='forex'), 'NZD', 'CAD', 5, 0.0001),
    ('NZDCHF', 'NZ Dollar / Swiss Franc', (SELECT id FROM instrument_segments WHERE name='forex'), 'NZD', 'CHF', 5, 0.0001),
    ('US100', 'US Tech 100', (SELECT id FROM instrument_segments WHERE name='indices'), 'US100', 'USD', 1, 0.1),
    ('JPN225', 'Japan 225', (SELECT id FROM instrument_segments WHERE name='indices'), 'JPN225', 'JPY', 1, 1),
    ('AUS200', 'Australia 200', (SELECT id FROM instrument_segments WHERE name='indices'), 'AUS200', 'AUD', 1, 0.1),
    ('AAPL', 'Apple Inc.', (SELECT id FROM instrument_segments WHERE name='stocks'), 'AAPL', 'USD', 2, 0.01),
    ('TSLA', 'Tesla Inc.', (SELECT id FROM instrument_segments WHERE name='stocks'), 'TSLA', 'USD', 2, 0.01),
    ('AMZN', 'Amazon.com Inc.', (SELECT id FROM instrument_segments WHERE name='stocks'), 'AMZN', 'USD', 2, 0.01),
    ('GOOGL', 'Alphabet Inc.', (SELECT id FROM instrument_segments WHERE name='stocks'), 'GOOGL', 'USD', 2, 0.01),
    ('MSFT', 'Microsoft Corp.', (SELECT id FROM instrument_segments WHERE name='stocks'), 'MSFT', 'USD', 2, 0.01),
    ('META', 'Meta Platforms Inc.', (SELECT id FROM instrument_segments WHERE name='stocks'), 'META', 'USD', 2, 0.01),
    ('NVDA', 'Nvidia Corp.', (SELECT id FROM instrument_segments WHERE name='stocks'), 'NVDA', 'USD', 2, 0.01),
    ('NFLX', 'Netflix Inc.', (SELECT id FROM instrument_segments WHERE name='stocks'), 'NFLX', 'USD', 2, 0.01) ON CONFLICT (symbol) DO NOTHING;

-- ─── Fix contract sizes (default 100000 is correct only for forex) ────────────
-- Precious metals: 100 oz per standard lot
UPDATE instruments SET contract_size = 100    WHERE symbol IN ('XAUUSD', 'XPTUSD');
-- Silver: 5000 oz per standard lot
UPDATE instruments SET contract_size = 5000   WHERE symbol = 'XAGUSD';
-- Energy: barrels / MMBtu per standard lot
UPDATE instruments SET contract_size = 1000   WHERE symbol IN ('USOIL', 'UKOIL');
UPDATE instruments SET contract_size = 10000  WHERE symbol = 'NATGAS';
-- Indices: 1 unit per lot  (P&L = lots × 1 × point_change)
UPDATE instruments SET contract_size = 1      WHERE symbol IN ('US30','US500','NAS100','UK100','GER40','US100','JPN225','AUS200');
-- Crypto major: 1 coin per lot
UPDATE instruments SET contract_size = 1      WHERE symbol IN ('BTCUSD','ETHUSD','LTCUSD','SOLUSD','BNBUSD');
-- Crypto small-price: 10000 units per lot  (keeps notional ~$3k-5k per lot)
UPDATE instruments SET contract_size = 10000  WHERE symbol IN ('XRPUSD','ADAUSD');
-- Micro-price crypto: keep 100000 default (DOGEUSD stays at 100000)
-- Stocks: 100 shares per lot
UPDATE instruments SET contract_size = 100    WHERE symbol IN ('AAPL','TSLA','AMZN','GOOGL','MSFT','META','NVDA','NFLX');
COMMIT;
SELECT s.display_name AS segment, COUNT(i.id) AS instruments FROM instrument_segments s LEFT JOIN instruments i ON i.segment_id=s.id GROUP BY s.display_name ORDER BY 1;
