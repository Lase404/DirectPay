// =================== Import Required Libraries ===================
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
const fs = require('fs');
const { createReadStream, unlink } = require('fs');
const { promisify } = require('util');
const unlinkAsync = promisify(unlink);
const path = require('path');
const sharp = require('sharp');
const requestIp = require('request-ip');
const ethers = require('ethers');
const { Core } = require('@walletconnect/core');
const { WalletKit } = require('@reown/walletkit');
const { getClient } = require('@reservoir0x/relay-sdk');
const QRCode = require('qrcode');
const { Transaction, PublicKey } = require('@solana/web3.js');

require('dotenv').config();

// =================== Initialize Logging ===================
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

// =================== Firebase Setup ===================
const serviceAccountPath = path.join(__dirname, 'directpay.json');
if (!fs.existsSync(serviceAccountPath)) {
  logger.error('Firebase service account file (directpay.json) not found.');
  process.exit(1);
}
const serviceAccount = require(serviceAccountPath);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpay9ja.firebaseio.com"
});
const db = admin.firestore();

// =================== Environment Variables ===================
const {
  BOT_TOKEN: TELEGRAM_BOT_TOKEN,
  PAYCREST_API_KEY,
  PAYCREST_CLIENT_SECRET,
  PAYCREST_RATE_API_URL = 'https://api.paycrest.io/v1/rates',
  PAYCREST_RETURN_ADDRESS = "0xYourReturnAddressHere",
  PERSONAL_CHAT_ID,
  PAYSTACK_API_KEY,
  ADMIN_IDS = '',
  WEBHOOK_PATH = '/webhook/telegram',
  WEBHOOK_PAYCREST_PATH = '/webhook/paycrest',
  WEBHOOK_BLOCKRADAR_PATH = '/webhook/blockradar',
  WEBHOOK_DOMAIN,
  PORT = 4000,
  BLOCKRADAR_BASE_API_KEY,
  BLOCKRADAR_BNB_API_KEY,
  BLOCKRADAR_POLYGON_API_KEY,
  MAX_WALLETS = 5,
  WALLETCONNECT_PROJECT_ID = '04c09c92b20bcfac0b83ee76fde1d782',
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY) {
  logger.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

const requiredKeys = [
  BLOCKRADAR_BASE_API_KEY,
  BLOCKRADAR_BNB_API_KEY,
  BLOCKRADAR_POLYGON_API_KEY,
  PERSONAL_CHAT_ID,
  ADMIN_IDS
];
for (const key of requiredKeys) {
  if (!key) {
    logger.error(`Missing required key: ${key}. Please update your .env file.`);
    process.exit(1);
  }
}

const WALLET_GENERATED_IMAGE = './wallet_generated_base1.png';
const DEPOSIT_SUCCESS_IMAGE = './deposit_success.png';
const PAYOUT_SUCCESS_IMAGE = './payout_success.png';
const ERROR_IMAGE = './error.png';

// =================== Initialize Express and Telegraf ===================
const app = express();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// =================== WalletConnect Setup ===================
const core = new Core({
  projectId: WALLETCONNECT_PROJECT_ID,
});

let walletKit; // Declare globally, initialize in async function

(async () => {
  try {
    walletKit = await WalletKit.init({
      core,
      metadata: {
        name: 'DirectPay',
        description: 'DirectPay Bot for Crypto-to-Naira Swaps',
        url: 'https://t.me/directpaynairabot',
        icons: ['https://assets.reown.com/reown-profile-pic.png'],
      },
    });
    logger.info('WalletConnect initialized successfully');
  } catch (error) {
    logger.error(`Failed to initialize WalletConnect: ${error.message}`);
    process.exit(1); // Exit if initialization fails
  }
})();
// =================== Define Constants ===================
const BASE_CHAIN_ID = 8453;
const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SOLANA_CHAIN_ID = 792703809;

const relaySupportedChains = {
  "Ethereum": 1,
  "Base": 8453,
  "Polygon": 137,
  "BNB Smart Chain": 56,
  "Solana": SOLANA_CHAIN_ID,
};

const chains = {
  'Base': {
    chainId: 8453,
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: BLOCKRADAR_BASE_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
    explorer: 'https://basescan.org/tx/',
    supportedAssets: ['USDC', 'USDT'],
    assets: { 
      'USDC': 'a8aae94e-a2c3-424c-8db5-ea7415166ce3', 
      'USDT': 'a8aae94e-a2c3-424c-8db5-ea7415166ce3' 
    }
  },
  'Ethereum': {
    chainId: 1,
    explorer: 'https://etherscan.io/tx/',
    supportedAssets: ['USDC', 'USDT'],
    assets: {
      'USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      'USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    }
  },
  'Polygon': {
    chainId: 137,
    id: 'f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a',
    key: BLOCKRADAR_POLYGON_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/addresses',
    explorer: 'https://polygonscan.com/tx/',
    supportedAssets: ['USDC', 'USDT'],
    assets: { 
      'USDC': 'f348e8e3-e0b4-4704-857e-c274ef000c00', 
      'USDT': 'c9d57a33-375b-46f7-b694-16e9b498e0e1' 
    }
  },
  'BNB Smart Chain': {
    chainId: 56,
    id: '7a844e91-5740-4589-9695-c74411adec7e',
    key: BLOCKRADAR_BNB_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
    explorer: 'https://bscscan.com/tx/',
    supportedAssets: ['USDT', 'USDC'],
    assets: { 
      'USDC': 'ff479231-0dbb-4760-b695-e219a50934af', 
      'USDT': '03a11a51-1422-4ac0-abc0-b2fed75e9fcb' 
    }
  },
};

// =================== Define Supported Banks ===================
const bankList = [
  // (Existing bank list unchanged)
];

// =================== Chain Mapping ===================
const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  'bnb': 'BNB Smart Chain',
};

// =================== Helper Functions ===================
function mapToPaycrest(asset, chainName) {
  if (!['USDC', 'USDT'].includes(asset)) return null;
  let token = asset.toUpperCase();
  let network;
  const chainKey = chainMapping[chainName.toLowerCase()] || chainName;
  if (/polygon/i.test(chainKey)) network = 'polygon';
  else if (/base/i.test(chainKey)) network = 'base';
  else if (/bnb-smart-chain/i.test(chainKey)) network = 'bnb-smart-chain';
  else return null;
  return { token, network };
}

function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset.toUpperCase()];
  if (!rate) throw new Error(`Unsupported asset received: ${asset}`);
  return parseFloat((amount * rate).toFixed(2));
}

function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return { verified: true, accountName: response.data.data.account_name };
  } catch (error) {
    logger.error(`Error verifying bank account (${accountNumber}, ${bankCode}): ${error.response ? error.response.data.message : error.message}`);
    return { verified: false, error: error.message };
  }
}

async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
    const paycrestMapping = mapToPaycrest(token, network);
    if (!paycrestMapping) throw new Error('No Paycrest mapping for the selected asset/chain.');

    const bank = bankList.find(b => b.name.toLowerCase() === recipientDetails.bankName.toLowerCase());
    if (!bank || !bank.paycrestInstitutionCode) {
      const errorMsg = `No Paycrest institution code found for bank: ${recipientDetails.bankName}`;
      logger.error(errorMsg);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ ${errorMsg} for user ${userId}.`);
      throw new Error(errorMsg);
    }

    const recipient = {
      institution: bank.paycrestInstitutionCode,
      accountIdentifier: recipientDetails.accountNumber,
      accountName: recipientDetails.accountName,
      memo: `Payment from DirectPay`,
      providerId: ""
    };

    const rate = exchangeRates[token];
    if (!rate) throw new Error(`Exchange rate for ${token} not available.`);

    const orderPayload = {
      amount: String(amount),
      rate: String(rate),
      network: paycrestMapping.network,
      token: paycrestMapping.token,
      recipient,
      returnAddress: userSendAddress || PAYCREST_RETURN_ADDRESS,
      feePercent: 2,
    };

    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (orderResp.data.status !== 'success') throw new Error(`Paycrest order creation failed: ${orderResp.data.message}`);
    return orderResp.data.data;
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.message}`);
    throw err;
  }
}

async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    const chainKey = chainMapping[chain.toLowerCase()] || chain;
    if (!chainKey) throw new Error(`Unsupported or unknown chain: ${chain}`);

    const chainData = chains[chainKey];
    if (!chainData) throw new Error(`Chain data not found for: ${chainKey}`);

    const resp = await axios.post(`https://api.blockradar.co/v1/wallets/${chainData.id}/withdraw`, {
      address,
      amount: String(amount),
      assetId,
      reference,
      metadata
    }, {
      headers: {
        'x-api-key': chainData.key,
        'Content-Type': 'application/json'
      }
    });
    const data = resp.data;
    if (data.statusCode !== 200) throw new Error(`Blockradar withdrawal error: ${JSON.stringify(data)}`);
    return data;
  } catch (error) {
    logger.error(`Error withdrawing from Blockradar: ${error.message}`);
    throw error;
  }
}

async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      const defaultState = {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        usePidgin: false,
        refundAddress: null
      };
      await db.collection('users').doc(userId).set(defaultState);
      logger.info(`Initialized default user state for ${userId}`);
      return defaultState;
    }
    return userDoc.data();
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    return {
      firstName: '',
      wallets: [],
      walletAddresses: [],
      hasReceivedDeposit: false,
      awaitingBroadcastMessage: false,
      usePidgin: false,
      refundAddress: null
    };
  }
}

async function updateUserState(userId, newState) {
  try {
    await db.collection('users').doc(userId).update(newState);
  } catch (error) {
    logger.error(`Error updating user state for ${userId}: ${error.message}`);
    throw error;
  }
}

async function generateWallet(chain) {
  try {
    const chainData = chains[chain];
    if (!chainData) throw new Error(`Unsupported chain: ${chain}`);

    const response = await axios.post(
      chainData.apiUrl,
      { name: `DirectPay_User_Wallet_${chain}` },
      { headers: { 'x-api-key': chainData.key } }
    );

    const walletAddress = response.data.data.address;
    if (!walletAddress) throw new Error('Wallet address not returned from Blockradar.');
    return walletAddress;
  } catch (error) {
    logger.error(`Error generating wallet for ${chain}: ${error.message}`);
    throw error;
  }
}

function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(requestBody);
  const calculatedSignature = hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(calculatedSignature), Buffer.from(signatureHeader));
  } catch (error) {
    return false;
  }
}

function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }
  return matrix[b.length][a.length];
}

function findClosestBank(input, bankList) {
  const inputLower = input.toLowerCase().trim();
  let bestMatch = null;
  let minDistance = Infinity;

  bankList.forEach((bank) => {
    bank.aliases.forEach((alias) => {
      const distance = levenshteinDistance(inputLower, alias);
      if (distance < minDistance) {
        minDistance = distance;
        bestMatch = bank;
      }
    });
  });

  return { bank: bestMatch, distance: minDistance };
}

function getNormalizedChainName(input) {
  return relaySupportedChains[Object.keys(relaySupportedChains).find(key => key.toLowerCase() === input.toLowerCase())] ? 
    Object.keys(relaySupportedChains).find(key => key.toLowerCase() === input.toLowerCase()) : null;
}

async function fetchTokenData(chainId, query) {
  try {
    const response = await axios.post('https://api.relay.link/currencies/v1', {
      defaultList: true,
      chainIds: [chainId],
      address: ethers.utils.isAddress(query) ? query : undefined,
      symbol: !ethers.utils.isAddress(query) ? query.toUpperCase() : undefined,
      verified: true,
      limit: 10,
      useExternalSearch: true,
      depositAddressOnly: false,
    });
    return response.data?.[0]?.filter(t => t.chainId === chainId) || [];
  } catch (error) {
    logger.error(`Error fetching token data for ${query} on chain ${chainId}: ${error.message}`);
    return [];
  }
}

async function toWeiWithDecimals(amount, tokenAddress, chainId) {
  const tokenData = await getTokenMetadata(tokenAddress, chainId);
  const decimals = tokenData?.decimals || (chainId === SOLANA_CHAIN_ID ? 9 : 18);
  const [integer, fraction = ""] = amount.toString().split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(integer + paddedFraction) * BigInt(10 ** (decimals - paddedFraction.length));
}

async function getTokenMetadata(tokenAddress, chainId) {
  const solanaTokens = {
    "SOL": { address: "11111111111111111111111111111111", decimals: 9, symbol: "SOL" },
    "USDC": { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, symbol: "USDC" },
    "wSOL": { address: "So11111111111111111111111111111111111111112", decimals: 9, symbol: "wSOL" },
    "USDT": { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, symbol: "USDT" }
  };
  if (chainId === SOLANA_CHAIN_ID) {
    const token = Object.values(solanaTokens).find(t => t.address.toLowerCase() === tokenAddress.toLowerCase());
    return token || (await fetchTokenData(chainId, tokenAddress))[0] || { address: tokenAddress, symbol: "Unknown", decimals: 9, chainId };
  }
  return (await fetchTokenData(chainId, tokenAddress))[0] || { address: tokenAddress, symbol: "Unknown", decimals: 18, chainId };
}

function fromWeiWithDecimals(amount, tokenData) {
  const decimals = tokenData?.decimals || 18;
  const amountStr = BigInt(amount).toString();
  const padded = amountStr.padStart(decimals + 1, "0");
  const integer = padded.slice(0, -decimals) || "0";
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function isValidSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

async function generateSolanaConnectionOptions(instructions, requestId) {
  try {
    const transaction = new Transaction();
    instructions.forEach(instr => {
      transaction.add({
        keys: instr.keys.map(key => ({
          pubkey: new PublicKey(key.pubkey),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        programId: new PublicKey(instr.programId),
        data: Buffer.from(instr.data, 'hex')
      });
    });

    const serializedTx = transaction.serialize({ requireAllSignatures: false }).toString('base64');
    const deeplink = `solana:${serializedTx}?requestId=${requestId}`;
    const tempQRPath = path.join(__dirname, `temp_sol_qr_${Date.now()}.png`);
    await QRCode.toFile(tempQRPath, deeplink);

    const deeplinks = {
      phantom: `https://phantom.app/ul/v1/sign?data=${encodeURIComponent(serializedTx)}&requestId=${requestId}`,
      solflare: `https://solflare.com/ul/v1/sign?data=${encodeURIComponent(serializedTx)}&requestId=${requestId}`,
    };

    return { tempQRPath, deeplink, deeplinks, requestId };
  } catch (error) {
    logger.error(`Error generating Solana wallet options: ${error.message}`);
    throw error;
  }
}

async function generateEVMConnectionOptions(chainId) {
  try {
    await walletKit.open({ chainId });
    const uri = walletKit.getUri();
    const tempQRPath = path.join(__dirname, `temp_evm_qr_${Date.now()}.png`);
    await QRCode.toFile(tempQRPath, uri);

    const deeplinks = {
      metamask: `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`,
      trustwallet: `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}`,
      rainbow: `https://rnbwapp.com/wc?uri=${encodeURIComponent(uri)}`,
    };

    return { tempQRPath, uri, deeplinks };
  } catch (error) {
    logger.error(`Error generating EVM wallet options: ${error.message}`);
    throw error;
  }
}



// =================== Define Scenes ===================

// Bank Linking Scene (Placeholder - Adjust as per your actual implementation)
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  async (ctx) => {
    await ctx.reply('Please enter your bank name (e.g., GTB, Zenith):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const bankName = ctx.message.text.trim();
    ctx.session.bankName = bankName; // Store temporarily
    await ctx.reply('Enter your 10-digit account number:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const accountNumber = ctx.message.text.trim();
    if (!/^\d{10}$/.test(accountNumber)) {
      await ctx.reply('Invalid account number! Must be 10 digits. Try again.');
      return;
    }
    ctx.session.accountNumber = accountNumber;
    await ctx.reply(`Bank: ${ctx.session.bankName}, Account: ${accountNumber}. Confirm? (Yes/No)`);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const response = ctx.message.text.trim().toLowerCase();
    if (response === 'yes') {
      await ctx.reply('Bank linked successfully!');
      delete ctx.session.bankName;
      delete ctx.session.accountNumber;
      return ctx.scene.leave();
    } else {
      await ctx.reply('Bank linking canceled.');
      return ctx.scene.leave();
    }
  }
);

// Send Message Scene (Placeholder - Adjust as per your actual implementation)
const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  async (ctx) => {
    await ctx.reply('Enter the message you want to send to all users:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const message = ctx.message.text.trim();
    ctx.session.broadcastMessage = message;
    await ctx.reply(`Message: "${message}". Confirm sending to all users? (Yes/No)`);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const response = ctx.message.text.trim().toLowerCase();
    if (response === 'yes') {
      await ctx.reply('Message sent to all users!'); // Placeholder logic
      delete ctx.session.broadcastMessage;
      return ctx.scene.leave();
    } else {
      await ctx.reply('Message sending canceled.');
      return ctx.scene.leave();
    }
  }
);

// Receipt Generation Scene (Placeholder - Adjust as per your actual implementation)
const receiptGenerationScene = new Scenes.WizardScene(
  'receipt_generation_scene',
  async (ctx) => {
    await ctx.reply('Enter transaction ID to generate receipt:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const txId = ctx.message.text.trim();
    ctx.session.txId = txId;
    await ctx.reply(`Generating receipt for Tx ID: ${txId}. Confirm? (Yes/No)`);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const response = ctx.message.text.trim().toLowerCase();
    if (response === 'yes') {
      await ctx.reply(`Receipt generated for Tx ID: ${ctx.session.txId}!`); // Placeholder logic
      delete ctx.session.txId;
      return ctx.scene.leave();
    } else {
      await ctx.reply('Receipt generation canceled.');
      return ctx.scene.leave();
    }
  }
);

// Sell Scene (Your Provided Code - Fixed Syntax)
const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 0: Collect Sell Details
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const args = ctx.message.text.split(' ').slice(1);

    if (args.length !== 3) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '📝 Use: `/sell <amount> <token_address> <chain>`\nE.g., `/sell 100 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 Base`\nOr use symbol: `/sell <amount> <symbol> <chain>`'
        : '📝 Usage: `/sell <amount> <token_address> <chain>`\nE.g., `/sell 100 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 Base`\nOr use symbol: `/sell <amount> <symbol> <chain>`');
      return ctx.scene.leave();
    }

    const [amountStr, tokenInput, chainInput] = args;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      await ctx.replyWithMarkdown(userState.usePidgin ? '❌ Amount must be number wey big pass 0!' : '❌ Amount must be a valid number > 0!');
      return ctx.scene.leave();
    }

    const chainName = getNormalizedChainName(chainInput);
    if (!chainName || !relaySupportedChains[chainName]) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? `❌ Chain "${chainInput}" no dey! Use: ${Object.keys(relaySupportedChains).join(', ')}`
        : `❌ Chain "${chainInput}" not supported! Use: ${Object.keys(relaySupportedChains).join(', ')}`);
      return ctx.scene.leave();
    }

    const chainId = relaySupportedChains[chainName];
    let tokenData;

    if (ethers.utils.isAddress(tokenInput)) {
      tokenData = (await fetchTokenData(chainId, tokenInput))[0];
      if (!tokenData) {
        await ctx.replyWithMarkdown(userState.usePidgin
          ? `❌ Token address "${tokenInput}" no dey for ${chainName}!`
          : `❌ Token address "${tokenInput}" not found on ${chainName}!`);
        return ctx.scene.leave();
      }
    } else {
      const tokens = await fetchTokenData(chainId, tokenInput);
      if (tokens.length === 0) {
        await ctx.replyWithMarkdown(userState.usePidgin
          ? `❌ Asset "${tokenInput}" no dey for ${chainName}! Enter the token address instead.`
          : `❌ Asset "${tokenInput}" not found on ${chainName}! Please provide the token address.`);
        return ctx.scene.leave();
      } else if (tokens.length > 1) {
        await ctx.replyWithMarkdown(userState.usePidgin
          ? `❌ Too many "${tokenInput}" for ${chainName}! Use token address instead:\n` + tokens.map(t => `- \`${t.address}\``).join('\n')
          : `❌ Multiple "${tokenInput}" found on ${chainName}! Use token address instead:\n` + tokens.map(t => `- \`${t.address}\``).join('\n'));
        return ctx.scene.leave();
      } else {
        tokenData = tokens[0];
      }
    }

    ctx.session.sellData = {
      amount,
      tokenAddress: tokenData.address,
      tokenSymbol: tokenData.symbol,
      tokenDecimals: tokenData.decimals,
      chainName,
      chainId,
    };

    await ctx.replyWithMarkdown(userState.usePidgin
      ? `🏦 Which bank you dey use? E.g., GTB, Zenith`
      : `🏦 Which bank do you use? E.g., GTB, Zenith`);
    return ctx.wizard.next();
  },
  // Step 1: Collect Bank Name
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const bankInput = ctx.message.text.trim();

    const { bank, distance } = findClosestBank(bankInput);
    if (!bank || distance > 3) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? `❌ Bank "${bankInput}" no dey! Try again. E.g., GTB, Zenith`
        : `❌ Bank "${bankInput}" not found! Try again. E.g., GTB, Zenith`);
      return;
    }

    ctx.session.sellData.bankName = bank.name;
    ctx.session.sellData.bankCode = bank.code;

    await ctx.replyWithMarkdown(userState.usePidgin
      ? `🏦 Okay, ${bank.name}. Now enter your 10-digit account number:`
      : `🏦 Got it, ${bank.name}. Now enter your 10-digit account number:`);
    return ctx.wizard.next();
  },
  // Step 2: Collect Account Number and Verify
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const accountNumber = ctx.message.text.trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ Account number must be 10 digits! Try again.'
        : '❌ Account number must be 10 digits! Try again.');
      return;
    }

    const { bankName, bankCode } = ctx.session.sellData;
    const verification = await verifyBankAccount(accountNumber, bankCode);

    if (!verification.verified) {
      logger.error(`Bank verification failed for user ${userId}: ${verification.error}`);
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ Bank no verify! Check your account number and try again.'
        : '❌ Failed to verify bank! Check your account number and try again.');
      return;
    }

    ctx.session.sellData.bankDetails = {
      accountNumber,
      bankName,
      bankCode,
      accountName: verification.accountName,
    };

    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? `✅ Bank don verify!\n- Name: ${verification.accountName}\n- Bank: ${bankName}\n- Account: \`${accountNumber}\`\n\nConfirm abeg?`
        : `✅ Bank verified!\n- Name: ${verification.accountName}\n- Bank: ${bankName}\n- Account: \`${accountNumber}\`\n\nConfirm?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_bank'), Markup.button.callback('❌ No', 'retry_bank')]
      ])
    );
    return ctx.wizard.next();
  },
  // Step 3: Connect Wallet
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);

    if (ctx.callbackQuery?.data === 'confirm_bank') {
      await ctx.answerCbQuery();
      const blockradarWalletAddress = await generateWallet('Base');
      ctx.session.sellData.blockradarWalletAddress = blockradarWalletAddress;

      const { chainId, chainName } = ctx.session.sellData;
      const isSolana = chainId === SOLANA_CHAIN_ID;

      if (isSolana) {
        await ctx.replyWithMarkdown(userState.usePidgin
          ? '🌞 Connect your Solana wallet:\n- Open your wallet (Phantom, Solflare, etc.) and get ready to scan or click.\nPress "Ready" when you dey set.'
          : '🌞 Connect your Solana wallet:\n- Open your wallet (Phantom, Solflare, etc.) and prepare to scan or click.\nPress "Ready" when ready.');
        return ctx.replyWithMarkdown('Press "Ready" to continue:', Markup.inlineKeyboard([
          [Markup.button.callback('✅ Ready', 'solana_ready'), Markup.button.callback('❌ Cancel', 'cancel')]
        ]));
      }

      const options = await generateEVMConnectionOptions(chainId);
      await ctx.replyWithPhoto({ source: fs.createReadStream(options.tempQRPath) }, {
        caption: userState.usePidgin
          ? `💼 Connect your wallet for ${chainName}:\n- Scan QR code or use link below (mobile only).\nPress "Connected" when you don finish.`
          : `💼 Connect your wallet for ${chainName}:\n- Scan QR code or use a link below (mobile only).\nPress "Connected" when done.`,
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url("MetaMask", options.deeplinks.metamask)],
          [Markup.button.url("Trust Wallet", options.deeplinks.trustwallet)],
          [Markup.button.url("Rainbow", options.deeplinks.rainbow)],
          [Markup.button.callback('✅ Connected', 'wallet_connected'), Markup.button.callback('❌ Cancel', 'cancel')]
        ]),
      });
      fs.unlinkSync(options.tempQRPath);
      return ctx.wizard.next();
    }

    if (ctx.callbackQuery?.data === 'retry_bank') {
      await ctx.answerCbQuery();
      await ctx.replyWithMarkdown(userState.usePidgin
        ? `🏦 Which bank you dey use? E.g., GTB, Zenith`
        : `🏦 Which bank do you use? E.g., GTB, Zenith`);
      return ctx.wizard.selectStep(1);
    }
  },
  // Step 4: Handle Solana Address or EVM Connection
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const { chainId, amount, tokenAddress, tokenSymbol, tokenDecimals, blockradarWalletAddress } = ctx.session.sellData;
    const isSolana = chainId === SOLANA_CHAIN_ID;

    if (isSolana && ctx.callbackQuery?.data === 'solana_ready') {
      await ctx.answerCbQuery();
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '🌞 Enter your Solana wallet address:'
        : '🌞 Enter your Solana wallet address:');
      return;
    }

    if (isSolana && ctx.message?.text) {
      const solanaAddress = ctx.message.text.trim();
      if (!isValidSolanaAddress(solanaAddress)) {
        await ctx.replyWithMarkdown(userState.usePidgin
          ? '❌ Solana address no good! Try again.'
          : '❌ Invalid Solana address! Try again.');
        return;
      }
      ctx.session.sellData.solanaAddress = solanaAddress;

      const amountInWei = await toWeiWithDecimals(amount, tokenAddress, chainId);
      const quote = await getClient().actions.getQuote({
        user: solanaAddress,
        originChainId: chainId,
        originCurrency: tokenAddress,
        destinationChainId: BASE_CHAIN_ID,
        destinationCurrency: BASE_USDC_ADDRESS,
        tradeType: "EXACT_INPUT",
        recipient: blockradarWalletAddress,
        amount: amountInWei.toString(),
        refundTo: solanaAddress,
        slippagePercentage: 1.5,
      });

      await showQuote(ctx, quote, { address: tokenAddress, symbol: tokenSymbol, decimals: tokenDecimals });
      return ctx.wizard.next();
    }

    if (ctx.callbackQuery?.data === 'wallet_connected') {
      await ctx.answerCbQuery();
      const provider = new ethers.providers.Web3Provider(walletKit.getProvider());
      const signer = provider.getSigner();
      const userAddress = await signer.getAddress();
      ctx.session.sellData.userAddress = userAddress;

      const amountInWei = await toWeiWithDecimals(amount, tokenAddress, chainId);
      const quote = await getClient().actions.getQuote({
        user: userAddress,
        originChainId: chainId,
        originCurrency: tokenAddress,
        destinationChainId: BASE_CHAIN_ID,
        destinationCurrency: BASE_USDC_ADDRESS,
        tradeType: "EXACT_INPUT",
        recipient: blockradarWalletAddress,
        amount: amountInWei.toString(),
        refundTo: userAddress,
        slippagePercentage: 1.5,
      });

      await showQuote(ctx, quote, { address: tokenAddress, symbol: tokenSymbol, decimals: tokenDecimals });
      return ctx.wizard.next();
    }

    if (ctx.callbackQuery?.data === 'cancel') {
      await ctx.replyWithMarkdown(userState.usePidgin ? '👋 Sell don cancel!' : '👋 Sell canceled!');
      await walletKit.close();
      delete ctx.session.sellData;
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }
  },
  // Step 5: Execute Transaction
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const { quote, chainId, tokenSymbol, blockradarWalletAddress, bankDetails } = ctx.session.sellData;

    if (ctx.callbackQuery?.data === 'confirm_quote') {
      await ctx.answerCbQuery();
      ctx.session.sellData.quoteConfirmed = true;

      const provider = new ethers.providers.Web3Provider(walletKit.getProvider());
      const signer = provider.getSigner();

      for (const step of quote.steps) {
        if (step.id === "approve" || step.id === "deposit") {
          await ctx.replyWithMarkdown(userState.usePidgin
            ? `📝 Sign ${step.id} now...`
            : `📝 Sign the ${step.id} transaction now...`);
          const tx = await signer.sendTransaction({
            to: step.items[0].data.to,
            data: step.items[0].data.data,
            value: step.items[0].data.value || "0",
          });
          await tx.wait();
          await ctx.replyWithMarkdown(`✅ ${step.id.charAt(0).toUpperCase() + step.id.slice(1)} done! Tx: \`${tx.hash}\``);
        }
      }

      const referenceId = generateReferenceId();
      await db.collection('transactions').doc(referenceId).set({
        userId,
        walletAddress: blockradarWalletAddress,
        chain: ctx.session.sellData.chainName,
        amount: ctx.session.sellData.amount,
        asset: tokenSymbol,
        transactionHash: quote.inTxHashes?.[0] || 'Pending',
        referenceId,
        bankDetails,
        payout: calculatePayout('USDC', fromWeiWithDecimals(quote.details.currencyOut.amount, { decimals: 6 })),
        timestamp: new Date().toISOString(),
        status: 'Pending',
      });

      ctx.session.sellData.referenceId = referenceId;
      const sentMessage = await ctx.replyWithMarkdown(userState.usePidgin
        ? '✅ Dey watch deposit to Blockradar wallet...'
        : '✅ Monitoring deposit to Blockradar wallet...');
      ctx.session.sellData.messageId = sentMessage.message_id;
      pollExecutionStatus(userId, quote, ctx.chat.id, userState, sentMessage.message_id, ctx.bot, blockradarWalletAddress, bankDetails, referenceId);
      return ctx.wizard.next();
    }

    if (ctx.callbackQuery?.data === 'confirm_solana_quote') {
      await ctx.answerCbQuery();
      ctx.session.sellData.quoteConfirmed = true;

      const depositStep = quote.steps.find(s => s.id === "deposit");
      if (!depositStep || !depositStep.items[0].data.instructions) {
        await ctx.replyWithMarkdown(userState.usePidgin
          ? '❌ No deposit instructions! Try again later.'
          : '❌ No deposit instructions found! Try again later.');
        return ctx.scene.leave();
      }

      const instructions = depositStep.items[0].data.instructions;
      const options = await generateSolanaConnectionOptions(instructions, quote.requestId);
      await ctx.replyWithPhoto({ source: fs.createReadStream(options.tempQRPath) }, {
        caption: userState.usePidgin
          ? `🌞 Complete your Solana transaction:\n- Scan QR code or [click here](${options.deeplink}) to open wallet.\nPress "Signed" when you don finish.`
          : `🌞 Complete your Solana transaction:\n- Scan QR code or [click here](${options.deeplink}) to open wallet.\nPress "Signed" when done.`,
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url("Phantom", options.deeplinks.phantom)],
          [Markup.button.url("Solflare", options.deeplinks.solflare)],
          [Markup.button.callback('✅ Signed', 'sol_tx_signed'), Markup.button.callback('❌ Cancel', 'cancel')]
        ]),
      });
      fs.unlinkSync(options.tempQRPath);
      return ctx.wizard.next();
    }

    if (ctx.callbackQuery?.data === 'cancel_quote') {
      await ctx.replyWithMarkdown(userState.usePidgin ? '👋 Sell don cancel!' : '👋 Sell canceled!');
      await walletKit.close();
      delete ctx.session.sellData;
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }
  },
  // Step 6: Finalize
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);

    if (ctx.callbackQuery?.data === 'sol_tx_signed') {
      await ctx.answerCbQuery();
      const { quote, blockradarWalletAddress, bankDetails } = ctx.session.sellData;

      const referenceId = generateReferenceId();
      await db.collection('transactions').doc(referenceId).set({
        userId,
        walletAddress: blockradarWalletAddress,
        chain: ctx.session.sellData.chainName,
        amount: ctx.session.sellData.amount,
        asset: ctx.session.sellData.tokenSymbol,
        transactionHash: 'Pending',
        referenceId,
        bankDetails,
        payout: calculatePayout('USDC', fromWeiWithDecimals(quote.details.currencyOut.amount, { decimals: 6 })),
        timestamp: new Date().toISOString(),
        status: 'Pending',
      });

      ctx.session.sellData.referenceId = referenceId;
      const sentMessage = await ctx.replyWithMarkdown(userState.usePidgin
        ? '✅ Dey watch deposit to Blockradar wallet...'
        : '✅ Monitoring deposit to Blockradar wallet...');
      ctx.session.sellData.messageId = sentMessage.message_id;
      pollExecutionStatus(userId, quote, ctx.chat.id, userState, sentMessage.message_id, ctx.bot, blockradarWalletAddress, bankDetails, referenceId);
    }

    if (ctx.callbackQuery?.data === 'cancel') {
      await ctx.replyWithMarkdown(userState.usePidgin ? '👋 Sell don cancel!' : '👋 Sell canceled!');
      await walletKit.close();
      delete ctx.session.sellData;
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    await walletKit.close();
    delete ctx.session.sellData;
    return ctx.scene.leave();
  }
);

// Register Scenes with Stage
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene, receiptGenerationScene, sellScene);
bot.use(session());
bot.use(stage.middleware());

// =================== Apply Telegraf Webhook Middleware ===================
if (WEBHOOK_DOMAIN && WEBHOOK_PATH) {
  const webhookURL = `${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`;
  bot.telegram.setWebhook(webhookURL)
    .then(() => logger.info(`Webhook set to ${webhookURL}`))
    .catch((err) => logger.error(`Failed to set webhook: ${err.message}`));
  app.use(bot.webhookCallback(WHOOK_PATH));
} else {
  logger.warn('WEBHOOK_DOMAIN or WEBHOOK_PATH not set. Falling back to long polling.');
  bot.launch().then(() => logger.info('Bot started using long polling.')).catch((err) => logger.error(`Failed to launch bot: ${err.message}`));
}

// =================== Apply Other Middlewares ===================
app.use(requestIp.mw());
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  await handlePaycrestWebhook(req, res);
});
app.use(bodyParser.json());

const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 0, USDT: 0 };

async function fetchExchangeRate(asset) {
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
      headers: { 'Authorization': `Bearer ${PAYCREST_API_KEY}`, 'Content-Type': 'application/json' },
    });
    if (response.data.status === 'success' && response.data.data) {
      const rate = parseFloat(response.data.data);
      if (isNaN(rate)) throw new Error(`Invalid rate data for ${asset}: ${response.data.data}`);
      return rate;
    } else {
      throw new Error(`Failed to fetch rate for ${asset}: ${response.data.message || 'Unknown error'}`);
    }
  } catch (error) {
    logger.error(`Error fetching exchange rate for ${asset} from Paycrest: ${error.message}`);
    throw error;
  }
}

async function fetchExchangeRates() {
  try {
    const rates = {};
    for (const asset of SUPPORTED_ASSETS) {
      rates[asset] = await fetchExchangeRate(asset);
    }
    exchangeRates = rates;
    logger.info('Exchange rates updated successfully from Paycrest.');
  } catch (error) {
    logger.error(`Error fetching exchange rates from Paycrest: ${error.message}`);
  }
}

fetchExchangeRates();
setInterval(fetchExchangeRates, 300000); // 5 minutes

// =================== Main Menu ===================
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? "💼 View Wallet" : "💼 Generate Wallet", "⚙️ Settings"],
    ["💰 Transactions", "📘 Learn About Base", "💸 Sell Crypto"],
    ["📈 View Current Rates"],
  ]).resize();

const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('📝 Rename Wallet', 'settings_rename_wallet')],
    [Markup.button.callback('🔙 Set Refund Address', 'settings_set_refund_address')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);

const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 All Transactions', 'admin_view_all_transactions')],
    [Markup.button.callback('👥 All Users', 'admin_view_users')],
    [Markup.button.callback('⏳ Pending Issues', 'admin_pending_issues')],
    [Markup.button.callback('📨 Send User Message', 'admin_send_message')],
    [Markup.button.callback('💰 Manual Payout', 'admin_manual_payout')],
    [Markup.button.callback('🔄 Refund Transaction', 'admin_refund_tx')],
    [Markup.button.callback('⚠️ API/Bot Status', 'admin_api_status')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);

// =================== Check if User is Admin ===================
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

// =================== /start Command ===================
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Something went wrong. Try again later.');
  }
});

async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);

    if (!userState.firstName && ctx.from.first_name) {
      await updateUserState(userId, { firstName: ctx.from.first_name || 'Valued User' });
      userState.firstName = ctx.from.first_name || 'Valued User';
    }
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error starting. Try again later.');
    return;
  }

  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
  const adminUser = isAdmin(userId);

  const greeting = walletExists
    ? userState.usePidgin
      ? `👋 Welcome back, ${userState.firstName}!\n\nThis na **DirectPay**, your crypto-to-cash plug.\n\n💡 *How to Start:*\n1. Link bank with "⚙️ Settings"\n2. Check your wallet address\n3. Send stablecoins or use "💸 Sell Crypto", get cash fast.\n\nRates dey fresh, money dey safe!\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na your wallet).`
      : `👋 Welcome back, ${userState.firstName}!\n\nThis is **DirectPay**, your crypto-to-cash solution.\n\n💡 *Quick Start:*\n1. Link your bank in "⚙️ Settings"\n2. View your wallet address\n3. Send stablecoins or use "💸 Sell Crypto", receive cash quickly.\n\nRates are updated, funds are secure!\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to your wallet).`
    : userState.usePidgin
      ? `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s start your crypto journey. Use the menu below.`
      : `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s begin your crypto journey. Use the menu below.`;

  if (adminUser) {
    try {
      const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
      ]));
      ctx.session.adminMessageId = sentMessage.message_id;
    } catch (error) {
      logger.error(`Error sending admin greeting to user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Error sending greeting. Try again later.');
    }
  } else {
    await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
  }
}

// =================== Generate Wallet Handler ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const ip = ctx.requestIp || 'Unknown';
  let suggestPidgin = ip.startsWith('41.') || ip.startsWith('197.') || ip.startsWith('105.');

  // Check if user is in bank_linking_scene
  if (ctx.scene.current && ctx.scene.current.id === 'bank_linking_scene') {
    const userState = await getUserState(userId);
    const msg = userState.usePidgin
      ? '⚠️ You dey link bank now. Finish am first or type "exit" to stop.'
      : '⚠️ You’re currently linking a bank. Finish that first or type "exit" to cancel.';
    await ctx.replyWithMarkdown(msg);
    return;
  }

  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets (${MAX_WALLETS}). Check your wallets first.`
        : `⚠️ You’ve reached the max wallet limit (${MAX_WALLETS}). Check your existing wallets first.`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    
    let ratesMessage = userState.usePidgin
      ? '📈 *Current Rates*\n\n'
      : '📈 *Current Exchange Rates*\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += userState.usePidgin
      ? `\nThese rates go work for your deposits and payouts.`
      : `\nThese rates apply to your deposits and payouts.`;
    await ctx.replyWithMarkdown(ratesMessage);

    const chain = 'Base';
    const generatingMessage = await ctx.replyWithMarkdown(userState.usePidgin
      ? `🔄 Generating wallet for ${chain}. Wait small...`
      : `🔄 Generating your wallet on ${chain}. Please wait...`);

    try {
      const walletAddress = await generateWallet(chain);
      userState.wallets.push({
        address: walletAddress,
        chain: chain,
        supportedAssets: chains[chain].supportedAssets,
        bank: null,
        amount: 0,
        creationDate: new Date().toISOString(),
        totalDeposits: 0,
        totalPayouts: 0
      });
      userState.walletAddresses.push(walletAddress);

      await updateUserState(userId, {
        wallets: userState.wallets,
        walletAddresses: userState.wallets.map(w => w.address), // Fixed typo here
      });

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain}: ${walletAddress}`, { parse_mode: 'Markdown' });
      logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);

      const newWalletIndex = userState.wallets.length - 1;
      ctx.session.walletIndex = newWalletIndex;

      await ctx.deleteMessage(generatingMessage.message_id);

      const successMsg = userState.usePidgin
        ? `✅ *Wallet Ready*\n\n` +
          `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
          `*Assets:* USDC, USDT\n` +
          `*Address:* \`${walletAddress}\`\n\n` +
          `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
        : `✅ *Wallet Generated*\n\n` +
          `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
          `*Assets:* USDC, USDT\n` +
          `*Address:* \`${walletAddress}\`\n\n` +
          `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;
      await ctx.replyWithMarkdown(successMsg, { reply_markup: getMainMenu(true, false) });

      if (suggestPidgin && !userState.usePidgin) {
        await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" to switch if you like.');
      }

      await ctx.scene.enter('bank_linking_scene');
    } catch (error) {
      logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Problem dey. Try again later.'
        : '❌ Something went wrong. Please try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    logger.error(`Error handling Generate Wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ E no work. Try again later.'
      : '❌ It didn’t work. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== View Wallet Handler ===================
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const ip = ctx.requestIp || 'Unknown';
  let suggestPidgin = ip.startsWith('41.') || ip.startsWith('197.') || ip.startsWith('105.');

  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey. Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Generate one with "💼 Generate Wallet".';
      await ctx.replyWithMarkdown(errorMsg);
      if (suggestPidgin && !userState.usePidgin) {
        await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" to switch if you like.');
      }
      return;
    }

    const pageSize = 3;
    const totalPages = Math.max(1, Math.ceil(userState.wallets.length / pageSize));
    ctx.session.walletsPage = ctx.session.walletsPage || 1;

    const generateWalletPage = async (page) => {
      const start = (page - 1) * pageSize;
      const end = Math.min(start + pageSize, userState.wallets.length);
      const wallets = userState.wallets.slice(start, end).sort((a, b) => new Date(b.creationDate) - new Date(a.creationDate));

      const timestamp = new Date().toISOString();
      let message = userState.usePidgin
        ? `💼 *Your Wallets* (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`
        : `💼 *Your Wallets* (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`;
      wallets.forEach((wallet, index) => {
        const walletNumber = start + index + 1;
        message += userState.usePidgin
          ? `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* \`${wallet.address}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`
          : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* \`${wallet.address}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`;
      });

      if (wallets.length === 0) {
        message += userState.usePidgin ? 'No wallets on this page yet.' : 'No wallets on this page yet.';
      }

      const navigationButtons = [];
      if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${page - 1}`));
      if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${page + 1}`));
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${page}`));

      return { message, inlineKeyboard: Markup.inlineKeyboard([navigationButtons]) };
    };

    const { message, inlineKeyboard } = await generateWalletPage(ctx.session.walletsPage);
    const sentMessage = await ctx.replyWithMarkdown(message, inlineKeyboard);
    ctx.session.walletMessageId = sentMessage.message_id;
    if (suggestPidgin && !userState.usePidgin) {
      await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" to switch if you like.');
    }
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ E no work. Try again later.'
      : '❌ Error fetching wallets. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action(/wallet_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    const pageSize = 3;
    const totalPages = Math.max(1, Math.ceil(userState.wallets.length / pageSize));

    if (requestedPage < 1 || requestedPage > totalPages) {
      await ctx.answerCbQuery(userState.usePidgin ? '⚠️ Page no dey.' : '⚠️ Page not found.', { show_alert: true });
      return;
    }

    ctx.session.walletsPage = requestedPage;

    const generateWalletPage = async (page) => {
      const start = (page - 1) * pageSize;
      const end = Math.min(start + pageSize, userState.wallets.length);
      const wallets = userState.wallets.slice(start, end).sort((a, b) => new Date(b.creationDate) - new Date(a.creationDate));

      const timestamp = new Date().toISOString();
      let message = userState.usePidgin
        ? `💼 *Your Wallets* (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`
        : `💼 *Your Wallets* (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`;
      wallets.forEach((wallet, index) => {
        const walletNumber = start + index + 1;
        message += userState.usePidgin
          ? `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* \`${wallet.address}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`
          : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* \`${wallet.address}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`;
      });

      if (wallets.length === 0) {
        message += userState.usePidgin ? 'No wallets on this page yet.' : 'No wallets on this page yet.';
      }

      const navigationButtons = [];
      if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${page - 1}`));
      if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${page + 1}`));
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${page}`));

      return { message, inlineKeyboard: Markup.inlineKeyboard([navigationButtons]) };
    };

    const { message, inlineKeyboard } = await generateWalletPage(requestedPage);
    if (ctx.session.walletMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.walletMessageId, null, message, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message, inlineKeyboard);
      ctx.session.walletMessageId = sentMessage.message_id;
    }
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating wallet pages for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Error turning page. Try again later.'
      : '❌ Error navigating wallets. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});


// =================== Transactions Handler ===================
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey, so no transactions yet.'
        : '❌ No wallets yet, so no transactions.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    const initialPrompt = userState.usePidgin
      ? '💰 *Transactions*\n\nPick how you want see them:'
      : '💰 *Transactions*\n\nChoose how to view your transactions:';

    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📋 All Transactions', 'tx_all')],
      [Markup.button.callback('✅ Completed', 'tx_status_Completed')],
      [Markup.button.callback('❌ Failed', 'tx_status_Failed')],
      [Markup.button.callback('⏳ Pending', 'tx_status_Pending')],
      [Markup.button.callback('🔄 Refunded', 'tx_status_Refunded')],
      [Markup.button.callback('🪙 Filter by Asset', 'tx_filter_asset')],
      [Markup.button.callback('📅 Filter by Date', 'tx_filter_date')]
    ]);

    await ctx.replyWithMarkdown(initialPrompt, inlineKeyboard);
  } catch (error) {
    logger.error(`Error initiating transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

async function displayTransactions(ctx, query, page = 1, filterDescription = '') {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const pageSize = 5;

  const transactionsSnapshot = await query
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .get();

  const totalDocsSnapshot = await query.count().get();
  const totalDocs = totalDocsSnapshot.data().count;
  const totalPages = Math.max(1, Math.ceil(totalDocs / pageSize));

  const timestamp = new Date().toISOString();
  let message = userState.usePidgin
    ? `💰 *Transactions*${filterDescription} (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`
    : `💰 *Transactions*${filterDescription} (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`;

  if (transactionsSnapshot.empty) {
    message += userState.usePidgin ? 'No transactions here yet.' : 'No transactions found yet.';
  } else {
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      const chain = tx.chain || 'Base';
      const blockExplorerUrl = chains[chain]?.explorer ? `${chains[chain].explorer}${tx.transactionHash}` : '#';
      message += userState.usePidgin
        ? `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
          `• *Asset:* ${tx.asset || 'N/A'}\n` +
          `• *Amount:* ${tx.amount || 'N/A'}\n` +
          `• *Payout:* ₦${tx.payout || 'N/A'}\n` +
          `• *Status:* ${tx.status || 'Pending'}\n` +
          `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n` +
          `• *Chain:* ${tx.chain || 'N/A'}\n` +
          (tx.status === 'Completed'
            ? `• *Tx Hash:* [${tx.transactionHash || 'N/A'}](${blockExplorerUrl})\n` +
              `• *Paid To:* ${tx.bankDetails?.bankName || 'N/A'} (****${tx.bankDetails?.accountNumber?.slice(-4) || 'N/A'})\n` +
              `• *Receiver:* ${tx.bankDetails?.accountName || 'N/A'}\n`
            : tx.status === 'Refunded'
            ? `• *Refunded To:* \`${tx.refundAddress || tx.walletAddress || 'N/A'}\`\n`
            : '') +
          `\n`
        : `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n` +
          `• *Asset:* ${tx.asset || 'N/A'}\n` +
          `• *Amount:* ${tx.amount || 'N/A'}\n` +
          `• *Payout:* ₦${tx.payout || 'N/A'}\n` +
          `• *Status:* ${tx.status || 'Pending'}\n` +
          `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n` +
          `• *Chain:* ${tx.chain || 'N/A'}\n` +
          (tx.status === 'Completed'
            ? `• *Transaction Hash:* [${tx.transactionHash || 'N/A'}](${blockExplorerUrl})\n` +
              `• *Paid To:* ${tx.bankDetails?.bankName || 'N/A'} (****${tx.bankDetails?.accountNumber?.slice(-4) || 'N/A'})\n` +
              `• *Receiver:* ${tx.bankDetails?.accountName || 'N/A'}\n`
            : tx.status === 'Refunded'
            ? `• *Refunded To:* \`${tx.refundAddress || tx.walletAddress || 'N/A'}\`\n`
            : '') +
          `\n`;
    });
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `tx_page_${page - 1}_${filterDescription.replace(/\s/g, '_')}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `tx_page_${page + 1}_${filterDescription.replace(/\s/g, '_')}`));
  navigationButtons.push(Markup.button.callback('🔄 Refresh', `tx_page_${page}_${filterDescription.replace(/\s/g, '_')}`));
  navigationButtons.push(Markup.button.callback('🏠 Exit', 'tx_exit'));

  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);
  await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
}

// =================== Transaction Action Handlers ===================
bot.action('tx_all', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ' - All Transactions');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying all transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action(/tx_status_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const status = ctx.match[1];
  try {
    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .where('status', '==', status)
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ` - ${status} Transactions`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying ${status} transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('tx_filter_asset', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '🪙 Pick asset to filter:'
    : '🪙 Select asset to filter by:';
  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('USDC', 'tx_asset_USDC')],
      [Markup.button.callback('USDT', 'tx_asset_USDT')],
      [Markup.button.callback('🔙 Back', 'tx_back')]
    ]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action(/tx_asset_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const asset = ctx.match[1];
  try {
    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .where('asset', '==', asset)
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ` - ${asset} Transactions`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying ${asset} transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('tx_filter_date', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const currentDate = new Date();
  const months = [];
  for (let i = 0; i < 3; i++) {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    const monthName = date.toLocaleString('default', { month: 'long' });
    months.push([Markup.button.callback(`${monthName} ${date.getFullYear()}`, `tx_date_${monthName}_${date.getFullYear()}`)]);
  }
  months.push([Markup.button.callback('🔙 Back', 'tx_back')]);

  const prompt = userState.usePidgin
    ? '📅 Pick month to filter:'
    : '📅 Select month to filter by:';
  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(months).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action(/tx_date_(.+)_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const month = ctx.match[1];
  const year = parseInt(ctx.match[2], 10);
  try {
    const startDate = new Date(`${month} 1, ${year}`);
    const endDate = new Date(year, startDate.getMonth() + 1, 0, 23, 59, 59, 999);

    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .where('timestamp', '>=', startDate.toISOString())
      .where('timestamp', '<=', endDate.toISOString())
      .orderBy('timestamp', 'desc');

    await displayTransactions(ctx, query, 1, ` - ${month} ${year}`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying transactions for ${month} ${year} for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('tx_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '💰 *Transactions*\n\nPick how you want see them:'
    : '💰 *Transactions*\n\nChoose how to view your transactions:';

  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('📋 All Transactions', 'tx_all')],
      [Markup.button.callback('✅ Completed', 'tx_status_Completed')],
      [Markup.button.callback('❌ Failed', 'tx_status_Failed')],
      [Markup.button.callback('⏳ Pending', 'tx_status_Pending')],
      [Markup.button.callback('🔄 Refunded', 'tx_status_Refunded')],
      [Markup.button.callback('🪙 Filter by Asset', 'tx_filter_asset')],
      [Markup.button.callback('📅 Filter by Date', 'tx_filter_date')]
    ]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('tx_exit', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await greetUser(ctx);
  ctx.answerCbQuery();
});

bot.action(/tx_page_(\d+)_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const page = parseInt(ctx.match[1], 10);
  const filterDescription = ctx.match[2].replace(/_/g, ' ');

  try {
    let query = db.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc');

    if (filterDescription.includes('Completed') || filterDescription.includes('Failed') || 
        filterDescription.includes('Pending') || filterDescription.includes('Refunded')) {
      const status = filterDescription.split(' - ')[1].replace(' Transactions', '');
      query = query.where('status', '==', status);
    } else if (filterDescription.includes('USDC') || filterDescription.includes('USDT')) {
      const asset = filterDescription.split(' - ')[1].replace(' Transactions', '');
      query = query.where('asset', '==', asset);
    } else if (filterDescription.match(/\w+ \d{4}/)) {
      const [month, year] = filterDescription.split(' - ')[1].split(' ');
      const startDate = new Date(`${month} 1, ${year}`);
      const endDate = new Date(year, startDate.getMonth() + 1, 0, 23, 59, 59, 999);
      query = query.where('timestamp', '>=', startDate.toISOString())
                   .where('timestamp', '<=', endDate.toISOString());
    }

    await displayTransactions(ctx, query, page, filterDescription);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating transaction page for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});


// =================== Sell Crypto Handler ===================
bot.hears('💸 Sell Crypto', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await ctx.replyWithMarkdown(userState.usePidgin
    ? '💸 Ready to sell? Use: `/sell <amount> <token> <chain>`\nE.g., `/sell 100 USDC Base`'
    : '💸 Ready to sell? Use: `/sell <amount> <token> <chain>`\nE.g., `/sell 100 USDC Base`');
});

bot.command('sell', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await ctx.scene.enter('sell_scene');
});

// =================== Support Handler ===================
bot.hears('ℹ️ Support', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const supportMsg = userState.usePidgin
    ? '🛠️ *Support*\n\nNeed help? Pick one:\n\n• How It Works\n• Transaction No Show\n• Contact Us'
    : '🛠️ *Support*\n\nNeed assistance? Choose an option:\n\n• How It Works\n• Transaction Not Received\n• Contact Us';
  await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Us', 'support_contact')]
  ]));
});

bot.action('support_how_it_works', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const howItWorksMsg = userState.usePidgin
    ? '📖 *How DirectPay Work*\n\n1. Generate wallet\n2. Link bank\n3. Send USDC/USDT\n4. Get Naira fast\n\nSimple as that!'
    : '📖 *How DirectPay Works*\n\n1. Generate a wallet\n2. Link your bank\n3. Send USDC/USDT\n4. Receive Naira quickly\n\nThat’s it!';
  await ctx.editMessageText(howItWorksMsg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]).reply_markup });
  ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const notReceivedMsg = userState.usePidgin
    ? '⚠️ *Transaction No Show*\n\nSend your Ref ID to [@maxcswap](https://t.me/maxcswap). We go check am fast.'
    : '⚠️ *Transaction Not Received*\n\nPlease send your Reference ID to [@maxcswap](https://t.me/maxcswap). We’ll check it quickly.';
  await ctx.editMessageText(notReceivedMsg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]).reply_markup });
  ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const contactMsg = userState.usePidgin
    ? '💬 *Contact Us*\n\nReach us at [@maxcswap](https://t.me/maxcswap) for any wahala.'
    : '💬 *Contact Us*\n\nReach out to us at [@maxcswap](https://t.me/maxcswap) for any issues.';
  await ctx.editMessageText(contactMsg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]).reply_markup });
  ctx.answerCbQuery();
});

bot.action('support_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const supportMsg = userState.usePidgin
    ? '🛠️ *Support*\n\nNeed help? Pick one:\n\n• How It Works\n• Transaction No Show\n• Contact Us'
    : '🛠️ *Support*\n\nNeed assistance? Choose an option:\n\n• How It Works\n• Transaction Not Received\n• Contact Us';
  await ctx.editMessageText(supportMsg, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
      [Markup.button.callback('💬 Contact Us', 'support_contact')]
    ]).reply_markup
  });
  ctx.answerCbQuery();
});

// =================== Learn About Base Handler ===================
bot.hears('📘 Learn About Base', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await displayLearnAboutBase(ctx, 1);
});

async function displayLearnAboutBase(ctx, page) {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  
  const pages = userState.usePidgin ? [
    '📘 *Wetin Be Base? (1/5)*\n\nBase na one sweet Ethereum Layer 2 chain wey Coinbase build. Imagine am like expressway for Ethereum—fast, cheap, and e dey dodge those crazy gas fees! E dey use Optimistic Rollups (fancy tech, abi?) to bundle transactions, so you fit do plenty things without breaking bank. Na game-changer for crypto lovers!',
    '📘 *How Base Start? (2/5)*\n\nBase no just fall from sky o! Coinbase, those big crypto guys, team up with Optimism (OP Stack) to born this chain in 2023. Dem say, "Why we go dey pay high gas fees when we fit build something better?" Now, Base dey live, dey breathe, and e dey carry thousands of transactions every day. E be like Ethereum’s fine younger brother!',
    '📘 *Wetin Base Fit Do? (3/5)*\n\nBase no dey play small! E dey support USDC and USDT—stablecoins wey you fit use send money quick-quick with small-small cost. You wan swap tokens? Trade NFT? Run DeFi app? Base get you covered! E dey process transactions off-chain, then report back to Ethereum, so everything stay secure but fast like Usain Bolt!',
    '📘 *Why Base Dey Hot? (4/5)*\n\nWhy people dey rush Base? Number one: e cheap—gas fees wey no go make you cry. Number two: e fast—transactions dey fly like jet. Number three: e secure—Ethereum dey back am up like big boss. Plus, e dey open for developers to build mad apps. Na why Base dey grow like wildfire for crypto space!',
    '📘 *Base Fun Facts & Future (5/5)*\n\nYou sabi say Base don handle millions of transactions since e land? E dey power big projects like Uniswap and Aave! And the future? E go dey bigger—more apps, more users, more vibes. Whether you dey move crypto-to-cash or you just wan flex with NFT, Base na your guy. Join the party now!'
  ] : [
    // Page 1
    '📘 *What is Base? (1/5)*\n\nBase is an Ethereum Layer 2 chain cooked up by Coinbase, and it’s a total vibe! Think of it as a turbocharged sidekick to Ethereum—blazing fast, super cheap, and it saves you from those wild gas fees. Using Optimistic Rollups (tech wizardry!), it bundles transactions to keep costs low and speed high. Crypto just got a lot more fun!',

    '📘 *How Did Base Come to Life? (2/5)*\n\nBase didn’t just pop out of nowhere! In 2023, Coinbase teamed up with the Optimism crew (OP Stack) to launch this bad boy. They were tired of Ethereum’s high fees and slow vibes, so they built a lean, mean transaction machine. Now, Base is thriving, handling thousands of transactions daily—like Ethereum’s cooler, younger sibling!',

    '📘 *What Can Base Do? (3/5)*\n\nBase is a jack-of-all-trades! It supports USDC and USDT, letting you send cash fast with fees so tiny you’ll barely notice. Want to swap tokens? Trade NFTs? Dive into DeFi? Base has your back! It processes everything off-chain, then syncs with Ethereum for security. It’s like having a Ferrari with a vault for a trunk!',

    '📘 *Why’s Base So Popular? (4/5)*\n\nWhy’s everyone obsessed with Base? First, it’s cheap—gas fees won’t drain your wallet. Second, it’s fast—transactions zoom by in a flash. Third, it’s secure—Ethereum’s got its back like a trusty bodyguard. Plus, developers love it for building wild apps. No wonder Base is the hottest thing in crypto right now!',

    '📘 *Fun Facts & The Future of Base (5/5)*\n\nDid you know Base has already processed millions of transactions? It’s powering giants like Uniswap and Aave! Looking ahead, it’s only getting bigger—more apps, more users, more excitement. Whether you’re cashing out crypto or flexing with NFTs, Base is your ticket to the future. Hop on board and enjoy the ride!'
  ];

  const totalPages = pages.length;
  if (page < 1 || page > totalPages) {
    await ctx.replyWithMarkdown('❌ Page no dey.' || '❌ Page not found.');
    return;
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `learn_base_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `learn_base_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🏠 Main Menu', 'back_to_main'));

  const message = pages[page - 1];
  await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([navigationButtons]));
}

bot.action(/learn_base_page_(\d+)/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  await displayLearnAboutBase(ctx, page);
  ctx.answerCbQuery();
});

bot.action('back_to_main', async (ctx) => {
  await greetUser(ctx);
  ctx.answerCbQuery();
});

// =================== View Current Rates Handler ===================
bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  let ratesMessage = userState.usePidgin
    ? '📈 *Current Rates*\n\n'
    : '📈 *Current Exchange Rates*\n\n';
  for (const [asset, rate] of Object.entries(exchangeRates)) {
    ratesMessage += `• *${asset}*: ₦${rate}\n`;
  }
  ratesMessage += userState.usePidgin
    ? '\nThese rates go work for your deposits and payouts.'
    : '\nThese rates apply to your deposits and payouts.';
  await ctx.replyWithMarkdown(ratesMessage);
});



// =================== Settings Handler ===================
bot.action('settings_set_refund_address', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const refundPrompt = userState.usePidgin
    ? '🔙 *Set Refund Address*\n\nEnter address where we go send funds if payout fail (e.g., 0x...). Type "default" to use wallet address:'
    : '🔙 *Set Refund Address*\n\nEnter the address where funds should be sent if a payout fails (e.g., 0x...). Type "default" to use your wallet address:';
  await ctx.replyWithMarkdown(refundPrompt);
  ctx.session.awaitingRefundAddress = true;
  ctx.answerCbQuery();
});


  
bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const settingsMsg = userState.usePidgin
    ? '⚙️ *Settings*\n\nPick one:'
    : '⚙️ *Settings*\n\nSelect an option:';
  await ctx.replyWithMarkdown(settingsMsg, getSettingsMenu());
});

bot.action(/settings_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const action = ctx.match[1];
  const userState = await getUserState(userId);

  switch (action) {
    case 'generate_wallet':
      try {
        if (userState.wallets.length >= MAX_WALLETS) {
          const errorMsg = userState.usePidgin
            ? `⚠️ You don reach max wallets (${MAX_WALLETS}). Check your wallets first.`
            : `⚠️ You’ve reached the max wallet limit (${MAX_WALLETS}). Check your existing wallets first.`;
          await ctx.replyWithMarkdown(errorMsg);
          return ctx.answerCbQuery();
        }

        let ratesMessage = userState.usePidgin
          ? '📈 *Current Rates*\n\n'
          : '📈 *Current Exchange Rates*\n\n';
        for (const [asset, rate] of Object.entries(exchangeRates)) {
          ratesMessage += `• *${asset}*: ₦${rate}\n`;
        }
        ratesMessage += userState.usePidgin
          ? `\nThese rates go work for your deposits and payouts.`
          : `\nThese rates apply to your deposits and payouts.`;
        await ctx.replyWithMarkdown(ratesMessage);

        const chain = 'Base';
        const generatingMessage = await ctx.replyWithMarkdown(userState.usePidgin
          ? `🔄 Generating wallet for ${chain}. Wait small...`
          : `🔄 Generating your wallet on ${chain}. Please wait...`);

        try {
          const walletAddress = await generateWallet(chain);
          userState.wallets.push({
            address: walletAddress,
            chain: chain,
            supportedAssets: chains[chain].supportedAssets,
            bank: null,
            amount: 0,
            creationDate: new Date().toISOString(),
            totalDeposits: 0,
            totalPayouts: 0
          });
          userState.walletAddresses.push(walletAddress);

          await updateUserState(userId, {
            wallets: userState.wallets,
            walletAddresses: userState.walletAddresses,
          });

          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain}: ${walletAddress}`, { parse_mode: 'Markdown' });
          logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);

          const newWalletIndex = userState.wallets.length - 1;
          ctx.session.walletIndex = newWalletIndex;

          await ctx.deleteMessage(generatingMessage.message_id);

          const successMsg = userState.usePidgin
            ? `✅ *Wallet Ready*\n\n` +
              `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
              `*Assets:* USDC, USDT\n` +
              `*Address:* \`${walletAddress}\`\n\n` +
              `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
            : `✅ *Wallet Generated*\n\n` +
              `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
              `*Assets:* USDC, USDT\n` +
              `*Address:* \`${walletAddress}\`\n\n` +
              `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;
          await ctx.replyWithMarkdown(successMsg);
          await ctx.scene.enter('bank_linking_scene');
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error generating wallet in settings for user ${userId}: ${error.message}`);
          const errorMsg = userState.usePidgin
            ? '❌ Problem dey. Try again later.'
            : '❌ Something went wrong. Please try again later.';
          await ctx.replyWithMarkdown(errorMsg);
          await ctx.deleteMessage(generatingMessage.message_id);
          ctx.answerCbQuery();
        }
      } catch (error) {
        logger.error(`Error initiating wallet generation in settings for user ${userId}: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '❌ E no work. Try again later.'
          : '❌ Failed to start wallet generation. Try again later.';
        await ctx.replyWithMarkdown(errorMsg);
        ctx.answerCbQuery();
      }
      break;

    case 'edit_bank':
      if (userState.wallets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No wallet dey. Generate one first.'
          : '❌ No wallets found. Generate one first.';
        await ctx.replyWithMarkdown(errorMsg);
        ctx.answerCbQuery();
        return;
      }
      const walletButtons = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain} (${wallet.bank ? 'Linked' : 'Not Linked'})`, `edit_bank_${index}`)
      ]);
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '🏦 *Edit Bank Details*\n\nPick wallet to link or edit bank:'
        : '🏦 *Edit Bank Details*\n\nSelect a wallet to link or edit bank details:', Markup.inlineKeyboard(walletButtons));
      ctx.answerCbQuery();
      break;

    case 'rename_wallet':
      if (userState.wallets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No wallet dey. Generate one first.'
          : '❌ No wallets found. Generate one first.';
        await ctx.replyWithMarkdown(errorMsg);
        ctx.answerCbQuery();
        return;
      }
      const renameButtons = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain} (${wallet.name || 'Unnamed'})`, `rename_wallet_${index}`)
      ]);
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '📝 *Rename Wallet*\n\nPick wallet to rename:'
        : '📝 *Rename Wallet*\n\nSelect a wallet to rename:', Markup.inlineKeyboard(renameButtons));
      ctx.answerCbQuery();
      break;

    case 'support':
      const supportMsg = userState.usePidgin
        ? '💬 *Support*\n\nContact [@maxcswap](https://t.me/maxcswap) for any wahala.'
        : '💬 *Support*\n\nContact [@maxcswap](https://t.me/maxcswap) for any issues.';
      await ctx.replyWithMarkdown(supportMsg);
      ctx.answerCbQuery();
      break;

    case 'back_main':
      await greetUser(ctx);
      ctx.answerCbQuery();
      break;

    default:
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ Option no dey. Try again.'
        : '❌ Invalid option. Try again.');
      ctx.answerCbQuery();
      break;
  }
});

bot.action(/edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Pick correct one.'
      : '❌ Invalid wallet selection. Choose a valid wallet.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('bank_linking_scene');
  ctx.answerCbQuery();
});

bot.action(/rename_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Pick correct one.'
      : '❌ Invalid wallet selection. Choose a valid wallet.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }

  ctx.session.walletIndex = walletIndex;
  const prompt = userState.usePidgin
    ? `📝 Enter new name for Wallet ${walletIndex + 1} - ${userState.wallets[walletIndex].chain}:`
    : `📝 Enter a new name for Wallet ${walletIndex + 1} - ${userState.wallets[walletIndex].chain}:`;
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingWalletName = true;
  ctx.answerCbQuery();
});


// =================== Admin Panel Handlers ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  if (ctx.session.adminMessageId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, '🔧 *Admin Panel*\n\nPick an option:', {
        parse_mode: 'Markdown',
        reply_markup: getAdminMenu().reply_markup
      });
    } catch (error) {
      logger.error(`Error editing admin panel message for ${userId}: ${error.message}`);
      const sentMessage = await ctx.replyWithMarkdown('🔧 *Admin Panel*\n\nPick an option:', getAdminMenu());
      ctx.session.adminMessageId = sentMessage.message_id;
    }
  } else {
    const sentMessage = await ctx.replyWithMarkdown('🔧 *Admin Panel*\n\nPick an option:', getAdminMenu());
    ctx.session.adminMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action('admin_view_all_transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const pageSize = 5;
  const page = ctx.session.adminTxPage || 1;
  const query = db.collection('transactions').orderBy('timestamp', 'desc');
  const transactionsSnapshot = await query.limit(pageSize).offset((page - 1) * pageSize).get();
  const totalDocsSnapshot = await query.count().get();
  const totalDocs = totalDocsSnapshot.data().count;
  const totalPages = Math.max(1, Math.ceil(totalDocs / pageSize));

  let message = `📋 *All Transactions* (Page ${page}/${totalPages})\n\n`;
  if (transactionsSnapshot.empty) {
    message += 'No transactions yet.';
  } else {
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
                 `• *User:* ${tx.userId}\n` +
                 `• *Asset:* ${tx.asset || 'N/A'}\n` +
                 `• *Amount:* ${tx.amount || 'N/A'}\n` +
                 `• *Payout:* ₦${tx.payout || 'N/A'}\n` +
                 `• *Status:* ${tx.status || 'Pending'}\n` +
                 `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`;
    });
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `admin_tx_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `admin_tx_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🔙 Back', 'admin_back_to_main'));

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([navigationButtons]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action(/admin_tx_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const page = parseInt(ctx.match[1], 10);
  ctx.session.adminTxPage = page;
  const pageSize = 5;
  const query = db.collection('transactions').orderBy('timestamp', 'desc');
  const transactionsSnapshot = await query.limit(pageSize).offset((page - 1) * pageSize).get();
  const totalDocsSnapshot = await query.count().get();
  const totalDocs = totalDocsSnapshot.data().count;
  const totalPages = Math.max(1, Math.ceil(totalDocs / pageSize));

  let message = `📋 *All Transactions* (Page ${page}/${totalPages})\n\n`;
  if (transactionsSnapshot.empty) {
    message += 'No transactions yet.';
  } else {
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
                 `• *User:* ${tx.userId}\n` +
                 `• *Asset:* ${tx.asset || 'N/A'}\n` +
                 `• *Amount:* ${tx.amount || 'N/A'}\n` +
                 `• *Payout:* ₦${tx.payout || 'N/A'}\n` +
                 `• *Status:* ${tx.status || 'Pending'}\n` +
                 `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`;
    });
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `admin_tx_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `admin_tx_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🔙 Back', 'admin_back_to_main'));

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([navigationButtons]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_view_users', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const usersSnapshot = await db.collection('users').get();
  let message = '👥 *All Users*\n\n';
  if (usersSnapshot.empty) {
    message += 'No users yet.';
  } else {
    usersSnapshot.forEach((doc) => {
      const user = doc.data();
      message += `*User ID:* ${doc.id}\n` +
                 `• *Name:* ${user.firstName || 'Unknown'}\n` +
                 `• *Wallets:* ${user.wallets.length}\n` +
                 `• *Refund Address:* ${user.refundAddress || 'Default (Wallet)'}\n\n`;
    });
  }

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_pending_issues', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const pendingSnapshot = await db.collection('transactions')
    .where('status', 'in', ['Pending', 'Failed'])
    .orderBy('timestamp', 'desc')
    .limit(10)
    .get();

  let message = '⏳ *Pending/Failed Transactions*\n\n';
  if (pendingSnapshot.empty) {
    message += 'No pending or failed transactions.';
  } else {
    pendingSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
                 `• *User:* ${tx.userId}\n` +
                 `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n` +
                 `• *Status:* ${tx.status}\n` +
                 `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`;
    });
  }

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  await ctx.scene.enter('send_message_scene');
  ctx.answerCbQuery();
});

bot.action('admin_manual_payout', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const prompt = '💰 *Manual Payout*\n\nEnter: `<User ID> <Amount> <Asset> <Reference ID>`\nE.g., `123456789 100 USDT REF-ABC123`';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingManualPayout = true;
  ctx.answerCbQuery();
});

bot.action('admin_refund_tx', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const prompt = '🔄 *Refund Transaction*\n\nEnter the Reference ID to refund:';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingRefundTx = true;
  ctx.answerCbQuery();
});

bot.action('admin_api_status', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  let statusMsg = '⚠️ *API/Bot Status*\n\n';
  try {
    await axios.get(PAYCREST_RATE_API_URL, { headers: { Authorization: `Bearer ${PAYCREST_API_KEY}` } });
    statusMsg += '✅ Paycrest API: Online\n';
  } catch (error) {
    statusMsg += '❌ Paycrest API: Offline\n';
  }

  try {
    await axios.get('https://api.blockradar.co/v1/status', { headers: { 'x-api-key': BLOCKRADAR_BASE_API_KEY } });
    statusMsg += '✅ Blockradar API: Online\n';
  } catch (error) {
    statusMsg += '❌ Blockradar API: Offline\n';
  }

  statusMsg += `✅ Bot: Running (Uptime: ${Math.floor(process.uptime() / 3600)}h)\n`;
  statusMsg += `📊 Exchange Rates: USDC ₦${exchangeRates.USDC}, USDT ₦${exchangeRates.USDT}`;

  await ctx.editMessageText(statusMsg, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  await ctx.editMessageText('🔧 *Admin Panel*\n\nPick an option:', {
    parse_mode: 'Markdown',
    reply_markup: getAdminMenu().reply_markup
  });
  ctx.answerCbQuery();
});
// all bot.on (text) in on place
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const text = ctx.message.text.trim();

  // Refund Address Handling
  if (ctx.session.awaitingRefundAddress) {
    let refundAddress = text.toLowerCase() === 'default' ? null : text;
    if (text.toLowerCase() === 'default') {
      if (userState.wallets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ You no get wallet yet. Generate one first.'
          : '❌ You don’t have any wallets yet. Generate one first.';
        await ctx.replyWithMarkdown(errorMsg);
        delete ctx.session.awaitingRefundAddress;
        return;
      } else if (userState.wallets.length > 1) {
        const walletButtons = userState.wallets.map((wallet, index) => [
          Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain} (${wallet.address.slice(0, 6)}...)`, `select_default_wallet_${index}`)
        ]);
        const prompt = userState.usePidgin
          ? '🏦 *Pick Default Wallet*\n\nYou get multiple wallets. Which one you want as default for refund?'
          : '🏦 *Select Default Wallet*\n\nYou have multiple wallets. Which one should be the default for refunds?';
        await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(walletButtons));
        ctx.session.awaitingDefaultWalletSelection = true;
        delete ctx.session.awaitingRefundAddress;
        return;
      } else {
        refundAddress = userState.wallets[0].address;
      }
    }

    if (refundAddress && !ethers.utils.isAddress(refundAddress)) {
      const errorMsg = userState.usePidgin
        ? '❌ Address no correct. Enter valid Ethereum address or "default".'
        : '❌ Invalid address. Please enter a valid Ethereum address or "default".';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    await updateUserState(userId, { refundAddress });
    const successMsg = userState.usePidgin
      ? refundAddress
        ? `✅ Refund address set to \`${refundAddress}\`.`
        : '✅ Refund address reset to default (your wallet).'
      : refundAddress
        ? `✅ Refund address set to \`${refundAddress}\`.`
        : '✅ Refund address reset to default (your wallet).';
    await ctx.replyWithMarkdown(successMsg);
    delete ctx.session.awaitingRefundAddress;
    return;
  }

  // Default Wallet Selection (this shouldn't be here, it's handled by bot.action)
  if (ctx.session.awaitingDefaultWalletSelection) {
    // This block is redundant since it's handled by bot.action(/select_default_wallet_(\d+)/)
    // Remove it from here to avoid confusion
    return;
  }

  // Wallet Renaming
  if (ctx.session.awaitingWalletName) {
    const walletIndex = ctx.session.walletIndex;
    if (walletIndex === undefined || walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey. Start again.'
        : '❌ Invalid wallet. Please start over.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.awaitingWalletName;
      delete ctx.session.walletIndex;
      return;
    }

    userState.wallets[walletIndex].name = text.slice(0, 20);
    await updateUserState(userId, { wallets: userState.wallets });
    const successMsg = userState.usePidgin
      ? `✅ Wallet ${walletIndex + 1} don rename to "${text.slice(0, 20)}".`
      : `✅ Wallet ${walletIndex + 1} renamed to "${text.slice(0, 20)}".`;
    await ctx.replyWithMarkdown(successMsg);
    delete ctx.session.awaitingWalletName;
    delete ctx.session.walletIndex;
    return;
  }

  // Language Switching
  if (text.toLowerCase() === 'pidgin') {
    await updateUserState(userId, { usePidgin: true });
    await ctx.replyWithMarkdown('✅ Switched to Pidgin! Enjoy the vibe.');
    await greetUser(ctx);
    return;
  }

  if (text.toLowerCase() === 'english') {
    await updateUserState(userId, { usePidgin: false });
    await ctx.replyWithMarkdown('✅ Switched to English! Enjoy your experience.');
    await greetUser(ctx);
    return;
  }

  // Admin Commands (Manual Payout and Refund)
  if (isAdmin(userId)) {
    if (ctx.session.awaitingManualPayout) {
      const [targetUserId, amountStr, asset, referenceId] = text.split(' ');
      const amount = parseFloat(amountStr);

      if (!targetUserId || isNaN(amount) || !asset || !referenceId || !SUPPORTED_ASSETS.includes(asset.toUpperCase())) {
        await ctx.replyWithMarkdown('❌ Format no correct. Use: `<User ID> <Amount> <Asset> <Reference ID>`\nE.g., `123456789 100 USDT REF-ABC123`');
        return;
      }

      try {
        const userState = await getUserState(targetUserId);
        if (!userState.wallets.length) {
          await ctx.replyWithMarkdown(`❌ User ${targetUserId} no get wallet.`);
          delete ctx.session.awaitingManualPayout;
          return;
        }

        const wallet = userState.wallets[0];
        if (!wallet.bank) {
          await ctx.replyWithMarkdown(`❌ User ${targetUserId} no link bank.`);
          delete ctx.session.awaitingManualPayout;
          return;
        }

        const payout = calculatePayout(asset.toUpperCase(), amount);
        const order = await createPaycrestOrder(targetUserId, payout, asset.toUpperCase(), wallet.chain, wallet.bank, wallet.address);

        await db.collection('transactions').doc(referenceId).set({
          userId: targetUserId,
          walletAddress: wallet.address,
          amount,
          asset: asset.toUpperCase(),
          payout,
          status: 'Pending',
          referenceId,
          chain: wallet.chain,
          timestamp: new Date().toISOString(),
          bankDetails: wallet.bank,
          paycrestOrderId: order.orderId
        });

        await bot.telegram.sendMessage(targetUserId, `✅ *Manual Payout Initiated*\n\n*Amount:* ${amount} ${asset}\n*Payout:* ₦${payout}\n*Ref ID:* \`${referenceId}\`\n\nFunds dey process to your bank.`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown(`✅ Payout of ${amount} ${asset} (₦${payout}) initiated for user ${targetUserId}. Ref: \`${referenceId}\``);
        logger.info(`Manual payout initiated by ${userId} for ${targetUserId}: ${amount} ${asset}, Ref: ${referenceId}`);
      } catch (error) {
        logger.error(`Error processing manual payout by ${userId}: ${error.message}`);
        await ctx.replyWithMarkdown('❌ Error starting payout. Check details and try again.');
      }
      delete ctx.session.awaitingManualPayout;
      return;
    }

    if (ctx.session.awaitingRefundTx) {
      const referenceId = text;
      try {
        const txDoc = await db.collection('transactions').doc(referenceId).get();
        if (!txDoc.exists) {
          await ctx.replyWithMarkdown(`❌ No transaction with Ref ID \`${referenceId}\`.`);
          delete ctx.session.awaitingRefundTx;
          return;
        }

        const tx = txDoc.data();
        if (tx.status === 'Refunded') {
          await ctx.replyWithMarkdown(`❌ Transaction \`${referenceId}\` don already refund.`);
          delete ctx.session.awaitingRefundTx;
          return;
        }

        const userState = await getUserState(tx.userId);
        const refundAddress = userState.refundAddress || tx.walletAddress;
        const chainData = chains[tx.chain];
        const assetId = chainData.assets[tx.asset];

        const refundResponse = await withdrawFromBlockradar(tx.chain, assetId, refundAddress, tx.amount, referenceId, { reason: 'Admin-initiated refund' });
        await db.collection('transactions').doc(referenceId).update({
          status: 'Refunded',
          refundAddress,
          refundTimestamp: new Date().toISOString(),
          refundTxHash: refundResponse.transactionHash
        });

        await bot.telegram.sendMessage(tx.userId, `🔄 *Transaction Refunded*\n\n*Ref ID:* \`${referenceId}\`\n*Amount:* ${tx.amount} ${tx.asset}\n*Sent To:* \`${refundAddress}\`\n\nCheck your wallet!`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown(`✅ Refunded ${tx.amount} ${tx.asset} to \`${refundAddress}\` for Ref ID \`${referenceId}\`.`);
        logger.info(`Admin ${userId} refunded transaction ${referenceId}: ${tx.amount} ${tx.asset} to ${refundAddress}`);
      } catch (error) {
        logger.error(`Error refunding transaction ${referenceId} by ${userId}: ${error.message}`);
        await ctx.replyWithMarkdown('❌ Error refunding transaction. Try again.');
      }
      delete ctx.session.awaitingRefundTx;
      return;
    }
  }
});

// =================== Text Handler ===================
bot.on('text', async (ctx) => {
  // (Existing text handler unchanged)
});

// =================== Paycrest Webhook Handler ===================
async function handlePaycrestWebhook(req, res) {
  // Log incoming request details for debugging (IP logging removed)
  logger.info(`Received Paycrest webhook - Headers: ${JSON.stringify(req.headers)}`);
  logger.info(`Body type: ${typeof req.body}, Is Buffer: ${Buffer.isBuffer(req.body)}`);

  const signature = req.headers['x-paycrest-signature'];
  if (!signature) {
    logger.error('Paycrest webhook received without signature');
    return res.status(401).send('Missing signature');
  }

  // Ensure req.body is a Buffer (from bodyParser.raw)
  if (!Buffer.isBuffer(req.body)) {
    logger.error(`Invalid raw body type: ${typeof req.body}`);
    return res.status(400).send('Invalid body type - Expected raw Buffer');
  }

  const rawBody = req.body.toString('utf8');
  if (!verifyPaycrestSignature(req.body, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error('Paycrest webhook signature verification failed');
    return res.status(401).send('Invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    logger.error(`Error parsing Paycrest webhook payload: ${error.message}`);
    return res.status(400).send('Invalid payload');
  }

  const { event, data } = payload;
  logger.info(`Received Paycrest webhook event: ${event}`);

  try {
    switch (event) {
      case 'order.created':
      case 'payment_order.pending':
        const existingTx = await db.collection('transactions')
          .where('paycrestOrderId', '==', data.orderId || data.id)
          .get();
        if (!existingTx.empty) {
          logger.warn(`Order ${data.orderId || data.id} already exists in transactions`);
          return res.status(200).send('Order already processed');
        }
        logger.info(`Order ${data.orderId || data.id} created/pending, awaiting further action`);
        break;

      case 'order.completed':
      case 'payment_order.settled':
        const completedTxSnapshot = await db.collection('transactions')
          .where('paycrestOrderId', '==', data.orderId || data.id)
          .limit(1)
          .get();

        if (completedTxSnapshot.empty) {
          logger.error(`No transaction found for Paycrest order ${data.orderId || data.id}`);
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
            `❗️ Paycrest order ${data.orderId || data.id} completed but no matching transaction found.`,
            { parse_mode: 'Markdown' }
          );
          return res.status(404).send('Transaction not found');
        }

        const txDoc = completedTxSnapshot.docs[0];
        const tx = txDoc.data();

        if (tx.status === 'Completed') {
          logger.warn(`Transaction ${tx.referenceId} already marked as Completed`);
          return res.status(200).send('Transaction already completed');
        }

        const amountPaid = data.amountPaid ? parseFloat(data.amountPaid) : tx.payout;
        const txHash = data.transactionHash || data.txHash || 'N/A';
        const percentSettled = ((amountPaid / tx.payout) * 100).toFixed(2);
        const rate = (amountPaid / tx.amount).toFixed(2);
        const network = tx.chain;

        await db.collection('transactions').doc(tx.referenceId).update({
          status: 'Completed',
          transactionHash: txHash,
          completedTimestamp: new Date().toISOString(),
          payout: amountPaid,
        });

        const userState = await getUserState(tx.userId);
        const successMsg = userState.usePidgin
          ? `✅ *Funds Credited*\n\n` +
            `*Your Deposit:*\n` +
            `• *Amount Sent:* ${tx.amount} ${tx.asset}\n` +
            `• *From Address:* \`${tx.walletAddress}\`\n` +
            `*Payout Details:*\n` +
            `• *Amount Paid:* ₦${amountPaid.toLocaleString()}\n` +
            `• *Percent Settled:* ${percentSettled}%\n` +
            `• *Exchange Rate:* ₦${rate} per ${tx.asset}\n` +
            `• *Network:* ${network}\n` +
            `• *Transaction Hash:* \`${txHash}\`\n` +
            `• *Paid To:* ${tx.bankDetails.bankName} (****${tx.bankDetails.accountNumber.slice(-4)})\n` +
            `• *Receiver:* ${tx.bankDetails.accountName || 'N/A'}\n` +
            `Money don enter your bank! Want sabi more about Base for future transaction? Click "📘 Learn About Base" for details!`
          : `✅ *Funds Credited*\n\n` +
            `*Your Deposit:*\n` +
            `• *Amount Sent:* ${tx.amount} ${tx.asset}\n` +
            `• *From Address:* \`${tx.walletAddress}\`\n` +
            `*Payout Details:*\n` +
            `• *Amount Paid:* ₦${amountPaid.toLocaleString()}\n` +
            `• *Percent Settled:* ${percentSettled}%\n` +
            `• *Exchange Rate:* ₦${rate} per ${tx.asset}\n` +
            `• *Network:* ${network}\n` +
            `• *Transaction Hash:* \`${txHash}\`\n` +
            `• *Paid To:* ${tx.bankDetails.bankName} (****${tx.bankDetails.accountNumber.slice(-4)})\n` +
            `• *Receiver:* ${tx.bankDetails.accountName || 'N/A'}\n` +
            `Funds are now in your bank! Want to learn more about Base? Click "📘 Learn About Base" for details!`;

        await bot.telegram.sendPhoto(tx.userId, { source: PAYOUT_SUCCESS_IMAGE }, {
          caption: successMsg,
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback('📘 Learn About Base', 'learn_base')]]).reply_markup
        });

        if (tx.messageId) {
          await bot.telegram.editMessageText(tx.userId, tx.messageId, null, successMsg, {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('📘 Learn About Base', 'learn_base')]]).reply_markup
          });
        }

        const feedbackMsg = userState.usePidgin
          ? `₦${amountPaid.toLocaleString()} don land your bank. How you see am?`
          : `₦${amountPaid.toLocaleString()} has reached your bank. How was it?`;
        await bot.telegram.sendMessage(tx.userId, feedbackMsg, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('👍 Good', `feedback_${tx.referenceId}_good`),
             Markup.button.callback('👎 Bad', `feedback_${tx.referenceId}_bad`)]
          ]).reply_markup
        });
        await txDoc.ref.update({ feedbackRequested: true });

        await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: PAYOUT_SUCCESS_IMAGE }, {
          caption: `✅ *Payout Completed*\n\n` +
                   `*User ID:* ${tx.userId}\n` +
                   `*First Name:* ${userState.firstName || 'Unknown'}\n` +
                   `*Amount:* ${tx.amount} ${tx.asset}\n` +
                   `*Paid:* ₦${amountPaid.toLocaleString()}\n` +
                   `*Percent Settled:* ${percentSettled}%\n` +
                   `*Tx Hash:* \`${txHash}\`\n` +
                   `*Bank:* ${tx.bankDetails.bankName}\n` +
                   `*Account:* ****${tx.bankDetails.accountNumber.slice(-4)}\n` +
                   `*Receiver:* ${tx.bankDetails.accountName || 'N/A'}`,
          parse_mode: 'Markdown'
        });

        logger.info(`Payout completed for ${tx.referenceId}: ${tx.amount} ${tx.asset} -> ₦${amountPaid}`);
        break;

      case 'order.failed':
      case 'payment_order.expired':
        const failedTxSnapshot = await db.collection('transactions')
          .where('paycrestOrderId', '==', data.orderId || data.id)
          .limit(1)
          .get();

        if (failedTxSnapshot.empty) {
          logger.error(`No transaction found for failed Paycrest order ${data.orderId || data.id}`);
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
            `❗️ Paycrest order ${data.orderId || data.id} failed/expired but no matching transaction found.`,
            { parse_mode: 'Markdown' }
          );
          return res.status(404).send('Transaction not found');
        }

        const failedTxDoc = failedTxSnapshot.docs[0];
        const failedTx = failedTxDoc.data();

        if (failedTx.status === 'Failed' || failedTx.status === 'Refunded' || failedTx.status === 'Expired') {
          logger.warn(`Transaction ${failedTx.referenceId} already marked as ${failedTx.status}`);
          return res.status(200).send('Transaction already processed');
        }

        const userStateFailed = await getUserState(failedTx.userId);
        const refundAddress = userStateFailed.refundAddress || failedTx.walletAddress;
        const chainData = chains[failedTx.chain];
        const assetId = chainData.assets[failedTx.asset];

        try {
          const refundResponse = await withdrawFromBlockradar(
            failedTx.chain,
            assetId,
            refundAddress,
            failedTx.amount,
            failedTx.referenceId,
            { reason: 'Payout failed/expired' }
          );
          await db.collection('transactions').doc(failedTx.referenceId).update({
            status: 'Refunded',
            refundAddress,
            refundTimestamp: new Date().toISOString(),
            refundTxHash: refundResponse.transactionHash,
            failureReason: data.reason || 'Order expired',
          });

          const refundMsg = userStateFailed.usePidgin
            ? `❌ *Payout Fail, Funds Refunded*\n\n` +
              `*Ref ID:* \`${failedTx.referenceId}\`\n` +
              `*Amount:* ${failedTx.amount} ${failedTx.asset}\n` +
              `*Refund To:* \`${refundAddress}\`\n` +
              `*Refund Tx Hash:* \`${refundResponse.transactionHash}\`\n` +
              `*Reason:* ${data.reason || 'Order expired'}\n\n` +
              `Check your wallet o!`
            : `❌ *Payout Failed, Funds Refunded*\n\n` +
              `*Reference ID:* \`${failedTx.referenceId}\`\n` +
              `*Amount:* ${failedTx.amount} ${failedTx.asset}\n` +
              `*Refunded To:* \`${refundAddress}\`\n` +
              `*Refund Transaction Hash:* \`${refundResponse.transactionHash}\`\n` +
              `*Reason:* ${data.reason || 'Order expired'}\n\n` +
              `Check your wallet!`;
          await bot.telegram.sendPhoto(failedTx.userId, { source: ERROR_IMAGE }, { 
            caption: refundMsg, 
            parse_mode: 'Markdown' 
          });

          const refundFeedbackMsg = userStateFailed.usePidgin
            ? `We don refund ${failedTx.amount} ${failedTx.asset} back to you. How you see this process?`
            : `We’ve refunded ${failedTx.amount} ${failedTx.asset} to your wallet. How was this experience?`;
          await bot.telegram.sendMessage(failedTx.userId, refundFeedbackMsg, {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('👍 Good', `feedback_${failedTx.referenceId}_good`),
               Markup.button.callback('👎 Bad', `feedback_${failedTx.referenceId}_bad`)]
            ]).reply_markup,
          });
          await failedTxDoc.ref.update({ feedbackRequested: true });

          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
            `❗️ Payout failed/expired for ${failedTx.userId}, refunded ${failedTx.amount} ${failedTx.asset} to ${refundAddress}.\n` +
            `Ref: ${failedTx.referenceId}\n` +
            `Refund Tx Hash: ${refundResponse.transactionHash}`, 
            { parse_mode: 'Markdown' }
          );
          logger.info(`Refunded ${failedTx.amount} ${failedTx.asset} for failed/expired payout ${failedTx.referenceId} to ${refundAddress}`);
        } catch (refundError) {
          logger.error(`Refund failed for ${failedTx.referenceId}: ${refundError.message}`);
          await db.collection('transactions').doc(failedTx.referenceId).update({
            status: event === 'order.failed' ? 'Failed' : 'Expired',
            failureReason: data.reason || 'Order expired',
            refundFailed: true,
          });
          await bot.telegram.sendMessage(failedTx.userId, 
            `❌ *Payout Failed*\n\n` +
            `Ref: \`${failedTx.referenceId}\`\n` +
            `Reason: ${data.reason || 'Order expired'}\n\n` +
            `Contact [@maxcswap](https://t.me/maxcswap) for help.`, 
            { parse_mode: 'Markdown' }
          );
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
            `❗️ Payout AND refund failed for ${failedTx.userId}.\n` +
            `Ref: ${failedTx.referenceId}\n` +
            `Reason: ${data.reason || 'Order expired'}\n` +
            `Refund Error: ${refundError.message}`, 
            { parse_mode: 'Markdown' }
          );
        }
        break;

      case 'payment_order.refunded':
        const refundedTxSnapshot = await db.collection('transactions')
          .where('paycrestOrderId', '==', data.id)
          .limit(1)
          .get();

        if (refundedTxSnapshot.empty) {
          logger.error(`No transaction found for refunded Paycrest order ${data.id}`);
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
            `❗️ Paycrest order ${data.id} refunded but no matching transaction found.`,
            { parse_mode: 'Markdown' }
          );
          return res.status(404).send('Transaction not found');
        }

        const refundedTxDoc = refundedTxSnapshot.docs[0];
        const refundedTx = refundedTxDoc.data();

        if (refundedTx.status === 'Refunded') {
          logger.warn(`Transaction ${refundedTx.referenceId} already marked as Refunded`);
          return res.status(200).send('Transaction already processed');
        }

        const refundAmount = parseFloat(data.amountReturned) || refundedTx.amount;
        await db.collection('transactions').doc(refundedTx.referenceId).update({
          status: 'Refunded',
          refundAddress: refundedTx.walletAddress,
          refundTimestamp: new Date().toISOString(),
          refundTxHash: data.txHash || 'N/A',
        });

        const refundedUserState = await getUserState(refundedTx.userId);
        const refundSuccessMsg = refundedUserState.usePidgin
          ? `✅ *Funds Refunded*\n\n` +
            `*Ref ID:* \`${refundedTx.referenceId}\`\n` +
            `*Amount:* ${refundAmount} ${refundedTx.asset}\n` +
            `*Refund To:* \`${refundedTx.walletAddress}\`\n` +
            `*Tx Hash:* \`${data.txHash || 'N/A'}\`\n\n` +
            `Money don return your wallet!`
          : `✅ *Funds Refunded*\n\n` +
            `*Reference ID:* \`${refundedTx.referenceId}\`\n` +
            `*Amount:* ${refundAmount} ${refundedTx.asset}\n` +
            `*Refunded To:* \`${refundedTx.walletAddress}\`\n` +
            `*Transaction Hash:* \`${data.txHash || 'N/A'}\`\n\n` +
            `Funds have been returned to your wallet!`;
        await bot.telegram.sendPhoto(refundedTx.userId, { source: PAYOUT_SUCCESS_IMAGE }, { 
          caption: refundSuccessMsg, 
          parse_mode: 'Markdown' 
        });

        const refundFeedbackMsgSuccess = refundedUserState.usePidgin
          ? `${refundAmount} ${refundedTx.asset} don return your wallet. How you see this refund?`
          : `${refundAmount} ${refundedTx.asset} has been refunded to your wallet. How was this refund experience?`;
        await bot.telegram.sendMessage(refundedTx.userId, refundFeedbackMsgSuccess, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('👍 Good', `feedback_${refundedTx.referenceId}_good`),
             Markup.button.callback('👎 Bad', `feedback_${refundedTx.referenceId}_bad`)]
          ]).reply_markup,
        });
        await refundedTxDoc.ref.update({ feedbackRequested: true });

        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
          `✅ Refund completed for user ${refundedTx.userId}:\n` +
          `Ref: ${refundedTx.referenceId}\n` +
          `Amount: ${refundAmount} ${refundedTx.asset}\n` +
          `Refund Tx Hash: ${data.txHash || 'N/A'}`, 
          { parse_mode: 'Markdown' }
        );
        logger.info(`Refund completed for ${refundedTx.referenceId}: ${refundAmount} ${refundedTx.asset}`);
        break;

      default:
        logger.warn(`Unhandled Paycrest event: ${event}`);
        return res.status(200).send('Event not handled');
    }

    res.status(200).send('Webhook processed');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook event ${event}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error processing Paycrest webhook (${event}): ${error.message}`, 
      { parse_mode: 'Markdown' }
    );
    res.status(500).send('Internal server error');
  }
}
// =================== Blockradar Webhook Handler ===================
app.post(WEBHOOK_BLOCKRADAR_PATH, async (req, res) => {
  const clientIp = req.clientIp;
  try {
    const event = req.body;
    logger.info(`Received Blockradar webhook from IP: ${clientIp} - ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';

    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook from IP: ${clientIp} - ${chainRaw}`);
      await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: ERROR_IMAGE }, {
        caption: `⚠️ Received deposit on unknown chain: \`${chainRaw}\` from IP: ${clientIp}`,
        parse_mode: 'Markdown'
      });
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;
    const chainData = chains[chain];
    const explorerUrl = `${chainData.explorer}${transactionHash}`;

    // Handle different event types
    switch (eventType) {
      case 'deposit.success':
        const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
        if (!existingTxSnapshot.empty) {
          logger.info(`Transaction with hash ${transactionHash} already exists from IP: ${clientIp}. Skipping.`);
          return res.status(200).send('OK');
        }

        const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
        if (usersSnapshot.empty) {
          logger.warn(`No user found for wallet ${walletAddress} from IP: ${clientIp}`);
          await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: ERROR_IMAGE }, {
            caption: `⚠️ No user found for wallet address: \`${walletAddress}\` from IP: ${clientIp}`,
            parse_mode: 'Markdown'
          });
          return res.status(200).send('OK');
        }

        const userDoc = usersSnapshot.docs[0];
        const userId = userDoc.id;
        const userState = userDoc.data();
        const wallet = userState.wallets.find((w) => w.address === walletAddress);
        const referenceId = event.data.reference || generateReferenceId();

        if (!SUPPORTED_ASSETS.includes(asset)) {
          const errorMsg = userState.usePidgin
            ? `⚠️ You send ${asset}, but we only take USDC/USDT.\n\nContact [@maxcswap](https://t.me/maxcswap) for help!`
            : `⚠️ Unsupported asset deposited: ${asset}.\n\nOnly USDC/USDT supported. Contact [@maxcswap](https://t.me/maxcswap) for assistance!`;
          await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
            caption: errorMsg,
            parse_mode: 'Markdown'
          });
          await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: ERROR_IMAGE }, {
            caption: `⚠️ User ${userId} deposited unsupported asset: ${amount} ${asset} on ${chainRaw} (Tx Hash: \`${transactionHash}\`)`,
            parse_mode: 'Markdown'
          });
          return res.status(200).send('OK');
        }

        const rate = exchangeRates[asset];
        if (!rate) {
          await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
            caption: userState.usePidgin
              ? `❌ Rate for ${asset} no dey. Contact [@maxcswap](https://t.me/maxcswap)!`
              : `❌ Rate for ${asset} unavailable. Contact [@maxcswap](https://t.me/maxcswap)!`,
            parse_mode: 'Markdown'
          });
          throw new Error(`Exchange rate for ${asset} not available.`);
        }

        const payout = calculatePayout(asset, amount);

        if (!wallet || !wallet.bank) {
          const noBankMsg = userState.usePidgin
            ? `⚠️ *Deposit Received - Bank Not Linked*\n\n` +
              `*Ref ID:* \`${referenceId}\`\n` +
              `*Amount:* ${amount} ${asset}\n` +
              `*Potential Payout:* ₦${payout.toLocaleString()}\n` +
              `*Network:* ${chainRaw}\n` +
              `*Wallet Address:* \`${walletAddress}\`\n` +
              `*Tx Hash:* [${transactionHash}](${explorerUrl})\n` +
              `*Date:* ${new Date(event.data.createdAt).toLocaleString()}\n\n` +
              `Deposit don land but no bank linked yet. Go "⚙️ Settings" to add bank and cash out ₦${payout.toLocaleString()}!`
            : `⚠️ *Deposit Received - Bank Not Linked*\n\n` +
              `*Reference ID:* \`${referenceId}\`\n` +
              `*Amount:* ${amount} ${asset}\n` +
              `*Potential Payout:* ₦${payout.toLocaleString()}\n` +
              `*Network:* ${chainRaw}\n` +
              `*Wallet Address:* \`${walletAddress}\`\n` +
              `*Transaction Hash:* [${transactionHash}](${explorerUrl})\n` +
              `*Date:* ${new Date(event.data.createdAt).toLocaleString()}\n\n` +
              `Deposit received, but no bank account is linked. Visit "⚙️ Settings" to add a bank and withdraw ₦${payout.toLocaleString()}!`;
          await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, {
            caption: noBankMsg,
            parse_mode: 'Markdown'
          });

          await db.collection('transactions').doc(referenceId).set({
            userId,
            walletAddress,
            chain: chainRaw,
            amount,
            asset,
            transactionHash,
            referenceId,
            payout,
            timestamp: new Date(event.data.createdAt).toISOString(),
            status: 'Pending'
          });

          await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: DEPOSIT_SUCCESS_IMAGE }, {
            caption: `⚠️ *Deposit - No Bank Linked*\n\n` +
                     `*User ID:* ${userId}\n` +
                     `*First Name:* ${userState.firstName || 'Unknown'}\n` +
                     `*Amount:* ${amount} ${asset}\n` +
                     `*NGN Amount:* ₦${payout.toLocaleString()}\n` +
                     `*Chain:* ${chainRaw}\n` +
                     `*Tx Hash:* [${transactionHash}](${explorerUrl})\n` +
                     `*Ref ID:* ${referenceId}`,
            parse_mode: 'Markdown'
          });

          logger.info(`Deposit processed for ${userId} (no bank): ${amount} ${asset} -> ₦${payout}, Ref: ${referenceId}, Tx: ${transactionHash}`);
          return res.status(200).send('OK');
        }

        // Handle Paycrest order creation with proper error catching
        let order;
        try {
          order = await createPaycrestOrder(userId, payout, asset, chain, wallet.bank, wallet.address);
        } catch (paycrestError) {
          logger.error(`Failed to create Paycrest order for user ${userId}: ${paycrestError.message}`);
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
            `❗️ Failed to create Paycrest order for user ${userId}: ${paycrestError.message}\n` +
            `Deposit: ${amount} ${asset}, Ref: ${referenceId}`,
            { parse_mode: 'Markdown' }
          );
          await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
            caption: userState.usePidgin
              ? `⚠️ We see your ${amount} ${asset} deposit (Ref: \`${referenceId}\`), but payout don jam issue.\n\nContact [@maxcswap](https://t.me/maxcswap) sharp sharp!`
              : `⚠️ We received your ${amount} ${asset} deposit (Ref: \`${referenceId}\`), but there’s an issue processing the payout.\n\nContact [@maxcswap](https://t.me/maxcswap) for help!`,
            parse_mode: 'Markdown'
          });
        }

        // Prepare transaction data, only include paycrestOrderId if order exists
        const transactionData = {
          userId,
          walletAddress,
          chain: chainRaw,
          amount,
          asset,
          transactionHash,
          referenceId,
          bankDetails: wallet.bank,
          payout,
          timestamp: new Date(event.data.createdAt).toISOString(),
          status: 'Pending',
          messageId: null
        };
        if (order && order.orderId) {
          transactionData.paycrestOrderId = order.orderId;
        }

        await db.collection('transactions').doc(referenceId).set(transactionData);

        userState.wallets = userState.wallets.map(w => 
          w.address === walletAddress ? { ...w, totalDeposits: (w.totalDeposits || 0) + amount } : w
        );
        await updateUserState(userId, { wallets: userState.wallets });

        const depositMsg = userState.usePidgin
          ? `✅ *Deposit Received*\n\n` +
            `*Ref ID:* \`${referenceId}\`\n` +
            `*Amount:* ${amount} ${asset}\n` +
            `*Payout:* ₦${payout.toLocaleString()}\n` +
            `*Network:* ${chainRaw}\n` +
            `*Wallet Address:* \`${walletAddress}\`\n` +
            `*Tx Hash:* [${transactionHash}](${explorerUrl})\n` +
            `*Bank:* ${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})\n` +
            `*Date:* ${new Date(event.data.createdAt).toLocaleString()}\n\n` +
            (order ? `We dey process your payout now!` : `Payout dey delayed, we dey fix am!`)
          : `✅ *Deposit Received*\n\n` +
            `*Reference ID:* \`${referenceId}\`\n` +
            `*Amount:* ${amount} ${asset}\n` +
            `*Payout:* ₦${payout.toLocaleString()}\n` +
            `*Network:* ${chainRaw}\n` +
            `*Wallet Address:* \`${walletAddress}\`\n` +
            `*Transaction Hash:* [${transactionHash}](${explorerUrl})\n` +
            `*Bank:* ${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})\n` +
            `*Date:* ${new Date(event.data.createdAt).toLocaleString()}\n\n` +
            (order ? `Your payout is being processed!` : `Payout delayed, we’re working on it!`);
        const msg = await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, {
          caption: depositMsg,
          parse_mode: 'Markdown'
        });
        await db.collection('transactions').doc(referenceId).update({ messageId: msg.message_id });

        await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: DEPOSIT_SUCCESS_IMAGE }, {
          caption: `💰 *Deposit Received*\n\n` +
                   `*User ID:* ${userId}\n` +
                   `*First Name:* ${userState.firstName || 'Unknown'}\n` +
                   `*Amount:* ${amount} ${asset}\n` +
                   `*NGN Amount:* ₦${payout.toLocaleString()}\n` +
                   `*Chain:* ${chainRaw}\n` +
                   `*Tx Hash:* [${transactionHash}](${explorerUrl})\n` +
                   `*Bank:* ${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})\n` +
                   `*Ref ID:* ${referenceId}` +
                   (order ? `` : `\n*Note:* Payout creation failed, check logs.`),
          parse_mode: 'Markdown'
        });

        logger.info(`Deposit processed for ${userId}: ${amount} ${asset} -> ₦${payout}, Ref: ${referenceId}, Tx: ${transactionHash}`);
        res.status(200).send('OK');
        break;

      case 'deposit.swept.success':
        const sweptAmount = parseFloat(event.data?.assetSweptAmount) || 0; // USDC amount swept
        const sweptTxHash = event.data?.assetSweptHash || transactionHash;
        const sweptExplorerUrl = `${chainData.explorer}${sweptTxHash}`;
        const sweptReferenceId = event.data?.reference || generateReferenceId();
        const refundAddress = walletAddress; // Refund to user's deposit wallet

        const sweptTxSnapshot = await db.collection('transactions')
          .where('transactionHash', '==', sweptTxHash)
          .get();
        if (!sweptTxSnapshot.empty) {
          logger.info(`Swept transaction with hash ${sweptTxHash} already exists from IP: ${clientIp}. Skipping.`);
          return res.status(200).send('OK');
        }

        const sweptUsersSnapshot = await db.collection('users')
          .where('walletAddresses', 'array-contains', walletAddress)
          .get();
        if (sweptUsersSnapshot.empty) {
          logger.warn(`No user found for wallet ${walletAddress} from IP: ${clientIp}`);
          await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: ERROR_IMAGE }, {
            caption: `⚠️ No user found for wallet address: \`${walletAddress}\` from IP: ${clientIp}`,
            parse_mode: 'Markdown'
          });
          return res.status(200).send('OK');
        }

        const sweptUserDoc = sweptUsersSnapshot.docs[0];
        const sweptUserId = sweptUserDoc.id;
        const sweptUserState = sweptUserDoc.data();
        const sweptWallet = sweptUserState.wallets.find((w) => w.address === walletAddress);

        if (!SUPPORTED_ASSETS.includes(asset)) {
          const errorMsg = sweptUserState.usePidgin
            ? `⚠️ You send ${asset}, but we only take USDC/USDT.\n\nContact [@maxcswap](https://t.me/maxcswap) for help!`
            : `⚠️ Unsupported asset swept: ${asset}.\n\nOnly USDC/USDT supported. Contact [@maxcswap](https://t.me/maxcswap) for assistance!`;
          await bot.telegram.sendPhoto(sweptUserId, { source: ERROR_IMAGE }, {
            caption: errorMsg,
            parse_mode: 'Markdown'
          });
          return res.status(200).send('OK');
        }

        const sweptRate = exchangeRates[asset];
        if (!sweptRate) {
          await bot.telegram.sendPhoto(sweptUserId, { source: ERROR_IMAGE }, {
            caption: sweptUserState.usePidgin
              ? `❌ Rate for ${asset} no dey. Contact [@maxcswap](https://t.me/maxcswap)!`
              : `❌ Rate for ${asset} unavailable. Contact [@maxcswap](https://t.me/maxcswap)!`,
            parse_mode: 'Markdown'
          });
          throw new Error(`Exchange rate for ${asset} not available.`);
        }

        const sweptPayout = calculatePayout(asset, sweptAmount); // Naira for display only

        if (!sweptWallet || !sweptWallet.bank) {
          const noBankMsg = sweptUserState.usePidgin
            ? `⚠️ *Deposit Received - Bank Not Linked*\n\n` +
              `*Ref ID:* \`${sweptReferenceId}\`\n` +
              `*Amount:* ${sweptAmount} ${asset}\n` +
              `*Potential Payout:* ₦${sweptPayout.toLocaleString()}\n` +
              `*Network:* ${chainRaw}\n` +
              `*Wallet Address:* \`${walletAddress}\`\n` +
              `*Tx Hash:* [${sweptTxHash}](${sweptExplorerUrl})\n` +
              `*Date:* ${new Date(event.data?.assetSweptAt).toLocaleString()}\n\n` +
              `Deposit don land but no bank linked yet. Go "⚙️ Settings" to add bank and cash out ₦${sweptPayout.toLocaleString()}!`
            : `⚠️ *Deposit Received - Bank Not Linked*\n\n` +
              `*Reference ID:* \`${sweptReferenceId}\`\n` +
              `*Amount:* ${sweptAmount} ${asset}\n` +
              `*Potential Payout:* ₦${sweptPayout.toLocaleString()}\n` +
              `*Network:* ${chainRaw}\n` +
              `*Wallet Address:* \`${walletAddress}\`\n` +
              `*Transaction Hash:* [${sweptTxHash}](${sweptExplorerUrl})\n` +
              `*Date:* ${new Date(event.data?.assetSweptAt).toLocaleString()}\n\n` +
              `Deposit received, but no bank account is linked. Visit "⚙️ Settings" to add a bank and withdraw ₦${sweptPayout.toLocaleString()}!`;
          await bot.telegram.sendPhoto(sweptUserId, { source: DEPOSIT_SUCCESS_IMAGE }, {
            caption: noBankMsg,
            parse_mode: 'Markdown'
          });

          await db.collection('transactions').doc(sweptReferenceId).set({
            userId: sweptUserId,
            walletAddress,
            chain: chainRaw,
            amount: sweptAmount,
            asset,
            transactionHash: sweptTxHash,
            referenceId: sweptReferenceId,
            payout: sweptPayout,
            timestamp: new Date(event.data?.assetSweptAt).toISOString(),
            status: 'Pending'
          });

          return res.status(200).send('OK');
        }

        // Create Paycrest order with USDC amount (not Naira)
        let sweptOrder;
        try {
          sweptOrder = await createPaycrestOrder(sweptUserId, sweptAmount, asset, chain, sweptWallet.bank, walletAddress);
        } catch (paycrestError) {
          logger.error(`Failed to create Paycrest order for user ${sweptUserId}: ${paycrestError.message}`);
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
            `❗️ Failed to create Paycrest order for user ${sweptUserId}: ${paycrestError.message}\n` +
            `Swept Amount: ${sweptAmount} ${asset}, Ref: ${sweptReferenceId}`,
            { parse_mode: 'Markdown' }
          );
        }

        // Store transaction data
        const sweptTransactionData = {
          userId: sweptUserId,
          walletAddress,
          chain: chainRaw,
          amount: sweptAmount,
          asset,
          transactionHash: sweptTxHash,
          referenceId: sweptReferenceId,
          bankDetails: sweptWallet.bank,
          payout: sweptPayout, // Naira for reference
          refundAddress,
          timestamp: new Date(event.data?.assetSweptAt).toISOString(),
          status: sweptOrder ? 'Pending' : 'Failed'
        };
        if (sweptOrder && sweptOrder.orderId) {
          sweptTransactionData.paycrestOrderId = sweptOrder.orderId;
        }
        await db.collection('transactions').doc(sweptReferenceId).set(sweptTransactionData);

        // Notify user
        const sweptDepositMsg = sweptUserState.usePidgin
          ? `✅ *Deposit Received*\n\n` +
            `*Ref ID:* \`${sweptReferenceId}\`\n` +
            `*Amount:* ${sweptAmount} ${asset}\n` +
            `*Payout:* ₦${sweptPayout.toLocaleString()}\n` +
            `*Network:* ${chainRaw}\n` +
            `*Wallet Address:* \`${walletAddress}\`\n` +
            `*Tx Hash:* [${sweptTxHash}](${sweptExplorerUrl})\n` +
            `*Bank:* ${sweptWallet.bank.bankName} (****${sweptWallet.bank.accountNumber.slice(-4)})\n` +
            `*Date:* ${new Date(event.data?.assetSweptAt).toLocaleString()}\n\n` +
            `Your payout of ₦${sweptPayout.toLocaleString()} go land your bank in 3-5 minutes. If e delay, we go refund ${sweptAmount} ${asset} to your address: \`${refundAddress}\`.`
          : `✅ *Deposit Received*\n\n` +
            `*Reference ID:* \`${sweptReferenceId}\`\n` +
            `*Amount:* ${sweptAmount} ${asset}\n` +
            `*Payout:* ₦${sweptPayout.toLocaleString()}\n` +
            `*Network:* ${chainRaw}\n` +
            `*Wallet Address:* \`${walletAddress}\`\n` +
            `*Transaction Hash:* [${sweptTxHash}](${sweptExplorerUrl})\n` +
            `*Bank:* ${sweptWallet.bank.bankName} (****${sweptWallet.bank.accountNumber.slice(-4)})\n` +
            `*Date:* ${new Date(event.data?.assetSweptAt).toLocaleString()}\n\n` +
            `Your payout of ₦${sweptPayout.toLocaleString()} will be credited to your bank in 3-5 minutes. If delayed, ${sweptAmount} ${asset} will be refunded to your address: \`${refundAddress}\`.`;
        await bot.telegram.sendPhoto(sweptUserId, { source: DEPOSIT_SUCCESS_IMAGE }, {
          caption: sweptDepositMsg,
          parse_mode: 'Markdown'
        });

        // Notify admin
        await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: DEPOSIT_SUCCESS_IMAGE }, {
          caption: `💰 *Deposit Swept*\n\n` +
                   `*User ID:* ${sweptUserId}\n` +
                   `*First Name:* ${sweptUserState.firstName || 'Unknown'}\n` +
                   `*Amount:* ${sweptAmount} ${asset}\n` +
                   `*NGN Amount:* ₦${sweptPayout.toLocaleString()}\n` +
                   `*Chain:* ${chainRaw}\n` +
                   `*Tx Hash:* [${sweptTxHash}](${sweptExplorerUrl})\n` +
                   `*Bank:* ${sweptWallet.bank.bankName} (****${sweptWallet.bank.accountNumber.slice(-4)})\n` +
                   `*Ref ID:* ${sweptReferenceId}` +
                   (sweptOrder ? '' : `\n*Note:* Payout creation failed, check logs.`),
          parse_mode: 'Markdown'
        });

        logger.info(`Swept deposit processed for ${sweptUserId}: ${sweptAmount} ${asset} -> ₦${sweptPayout}, Ref: ${sweptReferenceId}, Tx: ${sweptTxHash}`);
        res.status(200).send('OK');
        break;

      case 'withdraw.success':
        const withdrawUserId = event.data.metadata?.userId || 'Unknown';
        const withdrawReference = event.data.reference || 'N/A';
        logger.info(`Withdraw success for user ${withdrawUserId}: ${amount} ${asset} on ${chainRaw} (Tx Hash: ${transactionHash})`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
          `✅ *Withdraw Success*\n\n` +
          `*User ID:* ${withdrawUserId}\n` +
          `*Amount:* ${amount} ${asset}\n` +
          `*Chain:* ${chainRaw}\n` +
          `*Tx Hash:* \`${transactionHash}\`\n` +
          `*Reference:* \`${withdrawReference}\``, 
          { parse_mode: 'Markdown' }
        );
        res.status(200).send('OK');
        break;

      default:
        logger.warn(`Unhandled Blockradar event: ${eventType} from IP: ${clientIp}`);
        res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error handling Blockradar webhook from IP: ${clientIp}: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: ERROR_IMAGE }, {
      caption: `❗️ Error processing Blockradar webhook from IP: ${clientIp}: ${error.message}`,
      parse_mode: 'Markdown'
    });
  }
});


// =================== Server Startup ===================
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  bot.telegram.getMe().then((botInfo) => {
    logger.info(`Bot ${botInfo.username} started successfully`);
    bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ Bot ${botInfo.username} don start on port ${PORT}!`, { parse_mode: 'Markdown' })
      .catch((err) => logger.error(`Failed to send startup message: ${err.message}`));
  }).catch((err) => logger.error(`Error getting bot info: ${err.message}`));
});

// =================== Error Handling ===================
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.stack}`);
  bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Bot crash: ${error.message}`, { parse_mode: 'Markdown' })
    .catch((err) => logger.error(`Failed to send crash notification: ${err.message}`));
});

module.exports = app;
