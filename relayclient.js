const { RelayClient } = require('@reservoir0x/relay-sdk');

const relayClient = new RelayClient({
  baseApiUrl: 'https://api.relay.link',
});

module.exports = { relayClient };
