const { SignClient } = require('@walletconnect/sign-client');
const { getSdkError } = require('@walletconnect/utils');
const admin = require('firebase-admin');
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 })
  ],
});

class WalletConnectManager {
  constructor(projectId) {
    this.projectId = projectId || '04c09c92b20bcfac0b83ee76fde1d782';
    this.client = null;
    this.session = null;
  }

  async initialize() {
    try {
      this.client = await SignClient.init({
        projectId: this.projectId,
        metadata: {
          name: 'DirectPay',
          description: 'Sell crypto seamlessly',
          url: 'https://t.me/directpaynairabot',
          icons: ['https://assets.reown.com/reown-profile-pic.png'],
        },
      });
      logger.info('WalletConnect Sign Client initialized successfully');
      await this.logToBackend('WalletConnect Initialized', { status: 'success' });
    } catch (error) {
      logger.error('WalletConnect initialization failed:', error.message);
      await this.logToBackend('WalletConnect Initialization Failed', { status: 'error', error: error.message });
      throw error;
    }
  }

  async connect(chainId, timeoutMs = 60000) { // 60-second timeout
    if (!this.client) await this.initialize();

    try {
      const requiredNamespaces = {
        eip155: {
          methods: ['eth_sendTransaction', 'personal_sign'],
          chains: [`eip155:${chainId}`],
          events: ['chainChanged', 'accountsChanged'],
        },
      };

      const { uri, approval } = await this.client.connect({
        requiredNamespaces,
      });

      if (!uri) throw new Error('Failed to generate WalletConnect URI');

      logger.info('WalletConnect connection initiated', { uri, chainId });
      await this.logToBackend('WalletConnect Connect Initiated', { uri, chainId });

      // Add timeout to approval promise
      const approvalPromise = approval();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Wallet connection timed out')), timeoutMs)
      );
      this.session = await Promise.race([approvalPromise, timeoutPromise]);

      const userAddress = this.session.namespaces.eip155.accounts[0].split(':')[2];
      logger.info('WalletConnect session approved', { userAddress, sessionTopic: this.session.topic });
      await this.logToBackend('WalletConnect Session Approved', {
        userAddress,
        sessionTopic: this.session.topic,
        namespaces: this.session.namespaces,
      });

      return { uri, userAddress };
    } catch (error) {
      logger.error('WalletConnect connection failed:', error.message);
      await this.logToBackend('WalletConnect Connection Failed', { status: 'error', error: error.message });
      throw error;
    }
  }

  async sendTransaction({ chainId, from, to, value, data }) {
    if (!this.session) throw new Error('No active WalletConnect session');

    const request = {
      topic: this.session.topic,
      chainId: `eip155:${chainId}`,
      request: {
        method: 'eth_sendTransaction',
        params: [{
          from,
          to,
          value: value || '0x0',
          data: data || '0x',
        }],
      },
    };

    try {
      const result = await this.client.request(request);
      logger.info('WalletConnect transaction approved', { txHash: result });
      await this.logToBackend('WalletConnect Transaction Approved', {
        txHash: result,
        chainId,
        from,
        to,
      });
      return result;
    } catch (error) {
      logger.error('WalletConnect transaction failed:', error.message);
      await this.logToBackend('WalletConnect Transaction Failed', {
        status: 'error',
        error: error.message,
        chainId,
        from,
        to,
      });
      throw error;
    }
  }

  async disconnect() {
    if (!this.session) return;

    try {
      await this.client.disconnect({
        topic: this.session.topic,
        reason: getSdkError('USER_DISCONNECTED'),
      });
      logger.info('WalletConnect session disconnected', { topic: this.session.topic });
      await this.logToBackend('WalletConnect Session Disconnected', { topic: this.session.topic });
      this.session = null;
    } catch (error) {
      logger.error('WalletConnect disconnection failed:', error.message);
      await this.logToBackend('WalletConnect Disconnection Failed', { status: 'error', error: error.message });
    }
  }

  async logToBackend(event, data) {
    try {
      await admin.firestore().collection('walletconnect_logs').add({
        event,
        data,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to log WalletConnect event to backend:', error.message);
    }
  }

  getUserAddress() {
    if (!this.session) throw new Error('No active WalletConnect session');
    return this.session.namespaces.eip155.accounts[0].split(':')[2];
  }
}

module.exports = new WalletConnectManager();
