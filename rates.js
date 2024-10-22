// COINGECKO API IMPLEMENTATION FOR CONVERSION RATES
const axios = require('axios');
const winston = require('winston');

// Configure Winston Logger for the rates module
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'rates.log' })
  ],
});

class RatesManager {
  constructor() {
    this.rates = {};
    this.lastFetched = null;
    this.cacheDuration = 5 * 60 * 1000; // 5 minutes
  }

  // Fetch rates from CoinGecko
  async fetchRates() {
    try {
      logger.info('Fetching rates from CoinGecko...');
      const response = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price',
        {
          params: {
            ids: 'usd-coin,tether,ethereum',
            vs_currencies: 'ngn',
          },
        }
      );

      const data = response.data;
      this.rates = {
        USDC: data['usd-coin']['ngn'],
        USDT: data['tether']['ngn'],
        ETH: data['ethereum']['ngn'],
      };
      this.lastFetched = Date.now();
      logger.info(`Rates updated: ${JSON.stringify(this.rates)}`);
    } catch (error) {
      logger.error(`Error fetching rates: ${error.message}`);
      // If fetching fails, retain the existing rates
    }
  }

  // Get current rates, fetch if cache expired
  async getRates() {
    const now = Date.now();
    if (!this.lastFetched || now - this.lastFetched > this.cacheDuration) {
      await this.fetchRates();
    }
    return this.rates;
  }

  // Initialize by fetching rates immediately
  async init() {
    await this.fetchRates();
    // Set up interval to fetch rates periodically
    setInterval(() => this.fetchRates(), this.cacheDuration);
  }
}

module.exports = new RatesManager();
