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
const ethers = require('ethers');
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

// =================== Define Supported Banks ===================
const bankList = [
 { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ACCESSNGLA' },
 { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'], paycrestInstitutionCode: 'ZENITHNGLA' },
 { name: 'First Bank', code: '011', aliases: ['first', 'first bank', 'firstb', 'first bank nigeria'], paycrestInstitutionCode: 'FIRSTNGLA' },
 { name: 'GTBank', code: '058', aliases: ['gtbank', 'gtbank nigeria', 'gtb', 'gt bank'], paycrestInstitutionCode: 'GTBNGLA' },
 { name: 'UBA', code: '033', aliases: ['uba', 'uba nigeria', 'ubab'], paycrestInstitutionCode: 'UBANGLA' },
 { name: 'Fidelity Bank', code: '070', aliases: ['fidelity', 'fidelity bank', 'fidelityb', 'fidelity bank nigeria'], paycrestInstitutionCode: 'FIDNGLA' },
 { name: 'Heritage Bank', code: '030', aliases: ['heritage', 'heritage bank', 'heritageb', 'heritage bank nigeria'], paycrestInstitutionCode: 'HERITAGENGLA' },
 { name: 'Sterling Bank', code: '232', aliases: ['sterling', 'sterling bank', 'sterlingb', 'sterling bank nigeria'], paycrestInstitutionCode: 'STERLINGNGLA' },
 { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
 { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'], paycrestInstitutionCode: 'KUDANGPC' },
 { name: 'OPay', code: '999992', aliases: ['opay', 'opay nigeria'], paycrestInstitutionCode: 'OPAYNGPC' },
 { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'], paycrestInstitutionCode: 'PALMNGPC' },
 { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack mfb', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
 { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint', 'moniepoint mfb', 'moniepoint nigeria'], paycrestInstitutionCode: 'MONINGPC' },
 { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' },
];

// =================== Define Supported Chains ===================
const chains = {
 Base: {
 id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
 key: BLOCKRADAR_BASE_API_KEY,
 apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
 balanceUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/balances',
 supportedAssets: ['USDC', 'USDT'],
 network: 'Base',
 assets: { USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3', USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3' },
 explorer: 'https://basescan.org/tx/'
 },
 Polygon: {
 id: 'f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a',
 key: BLOCKRADAR_POLYGON_API_KEY,
 apiUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/addresses',
 balanceUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/balances',
 supportedAssets: ['USDC', 'USDT'],
 network: 'Polygon',
 assets: { USDC: 'f348e8e3-e0b4-4704-857e-c274ef000c00', USDT: 'c9d57a33-375b-46f7-b694-16e9b498e0e1' },
 explorer: 'https://polygonscan.com/tx/'
 },
 'BNB Smart Chain': {
 id: '7a844e91-5740-4589-9695-c74411adec7e',
 key: BLOCKRADAR_BNB_API_KEY,
 apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
 balanceUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/balances',
 supportedAssets: ['USDT', 'USDC'],
 network: 'BNB Smart Chain',
 assets: { USDC: 'ff479231-0dbb-4760-b695-e219a50934af', USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb' },
 explorer: 'https://bscscan.com/tx/'
 }
};

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
 const chainKey = chainMapping[chainName.toLowerCase()];
 if (!chainKey) {
 logger .error(`No mapping found for chain name: ${chainName}`);
 return null;
 }
 if (/polygon/i.test(chainKey)) network = 'polygon';
 else if (/base/i.test(chainKey)) network = 'base';
 else if (/bnb-smart-chain/i.test(chainKey)) network = 'bnb-smart-chain';
 else return null;
 return { token, network };
}

async function fetchExchangeRate(asset) {
 try {
 const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
 headers: { 
 'Authorization': `Bearer ${PAYCREST_API_KEY}`, 
 'Content-Type': 'application/json' 
 },
 params: { asset }
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
 await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
 `❗️ Error fetching exchange rate for ${asset}:\n` +
 `*Error:* ${error.message}\n` +
 `*Cause:* Paycrest API may be down or returned invalid data.\n` +
 `*Action:* Check API status or retry later.`,
 { parse_mode: 'Markdown' }
 );
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
 logger.info(`Exchange rates updated successfully: ${JSON.stringify(exchangeRates)}`);
 } catch (error) {
 logger.error(`Error fetching exchange rates: ${error.message}`);
 throw error;
 }
}

function calculatePayout(asset, amount) {
 const rate = exchangeRates[asset];
 if (!rate) throw new Error(`Exchange rate not available for ${asset}`);
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
 if (!response.data.status || !response.data.data?.account_name) {
 throw new Error(`Could not resolve account name. Response: ${JSON.stringify(response.data)}`);
 }
 return response.data;
 } catch (error) {
 const errorMsg = error.response ? error.response.data.message : error.message;
 logger.error(`Error verifying bank account (${accountNumber}, ${bankCode}): ${errorMsg}`);
 await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
 `❗️ Error verifying bank account (${accountNumber}, ${bankCode}):\n` +
 `*Error:* ${errorMsg}\n` +
 `*Cause:* Invalid account number, bank code, or Paystack API issue.\n` +
 `*Action:* Verify inputs or check Paystack status.`,
 { parse_mode: 'Markdown' }
 );
 throw new Error(`Could not resolve account name. Check parameters or try again.`);
 }
}

async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
 try {
 const paycrestMapping = mapToPaycrest(token, network);
 if (!paycrestMapping) throw new Error('No Paycrest mapping for the selected asset/chain.');

 const bank = bankList.find(b => b.name.toLowerCase() === recipientDetails.bankName.toLowerCase());
 if (!bank || !bank.paycrestInstitutionCode) {
 throw new Error(`No Paycrest institution code found for bank: ${recipientDetails.bankName}`);
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
 } catch (error) {
 logger.error(`Error creating Paycrest order for user ${userId}: ${error.message}`);
 await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
 `❗️ Error creating Paycrest order for user ${userId}:\n` +
 `*Error:* ${error.message}\n` +
 `*Cause:* Paycrest API issue, invalid data, or missing rates.\n` +
 `*Action:* Check API status or order details.`,
 { parse_mode: 'Markdown' }
 );
 throw error;
 }
}

async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
 try {
 const chainKey = chainMapping[chain.toLowerCase()];
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
 await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
 `❗️ Error withdrawing from Blockradar:\n` +
 `*Error:* ${error.message}\n` +
 `*Cause:* Blockradar API issue or invalid parameters.\n` +
 `*Action:* Verify chain/asset details or check API status.`,
 { parse_mode: 'Markdown' }
 );
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
 await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
 `❗️ Error fetching user state for ${userId}:\n` +
 `*Error:* ${error.message}\n` +
 `*Cause:* Firestore connection issue or permissions.\n` +
 `*Action:* Check Firestore status or user ID.`,
 { parse_mode: 'Markdown' }
 );
 throw error;
 }
}

async function updateUserState(userId, newState) {
 try {
 await db.collection('users').doc(userId).update(newState);
 } catch (error) {
 logger.error(`Error updating user state for ${userId}: ${error.message}`);
 await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
 `❗️ Error updating user state for ${userId}:\n` +
 `*Error:* ${error.message}\n` +
 `*Cause:* Firestore write failure or invalid data.\n` +
 `*Action:* Check Firestore status or data format.`,
 { parse_mode: 'Markdown' }
 );
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
 await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
 `❗️ Error generating wallet for ${chain}:\n` +
 `*Error:* ${error.message}\n` +
 `*Cause:* Blockradar API failure or invalid request.\n` +
 `*Action:* Check API key or Blockradar status.`,
 { parse_mode: 'Markdown' }
 );
 throw error;
 }
}

async function getWalletBalance(walletAddress, chain) {
  try {
    const chainData = chains[chain];
    if (!chainData) throw new Error(`Chain ${chain} not supported`);

    const response = await axios.get(chainData.balanceUrl, {
      headers: { 'x-api-key': chainData.key }
    });

    const balances = response.data.data;
    const walletBalance = balances.find(b => b.address === walletAddress);
    return walletBalance ? { USDC: walletBalance.USDC || 0, USDT: walletBalance.USDT || 0 } : { USDC: 0, USDT: 0 };
  } catch (error) {
    logger.error(`Error fetching balance for wallet ${walletAddress} on ${chain}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error fetching wallet balance:\n` +
      `*Wallet:* ${walletAddress}\n` +
      `*Chain:* ${chain}\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Blockradar API failure or invalid wallet address.\n` +
      `*Action:* Verify wallet address and chain config, or check Blockradar API status.`,
      { parse_mode: 'Markdown' }
    );
    return { USDC: 0, USDT: 0 }; // Return zero balances on error to prevent downstream failures
  }
}

// =================== Admin Menu Definition ===================
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
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error in /start command:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Greeting logic or user state fetch failed.\n` +
      `*Action:* Check greetUser function or Firestore status.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.replyWithMarkdown('❌ Something went wrong. Try again later.');
  }
});

async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  try {
    let userState = await getUserState(userId);
    if (!userState.firstName && ctx.from.first_name) {
      await updateUserState(userId, { firstName: ctx.from.first_name || 'Valued User' });
      userState.firstName = ctx.from.first_name || 'Valued User';
    }

    const walletExists = userState.wallets.length > 0;
    const hasBankLinked = walletExists && userState.wallets.some(w => w.bank);
    const adminUser = isAdmin(userId);

    const greeting = walletExists
      ? userState.usePidgin
        ? `👋 Welcome back, ${userState.firstName}!\n\nThis na **DirectPay**, your crypto-to-cash plug.\n\n💡 *How to Start:*\n1. ${hasBankLinked ? 'Check wallet' : 'Link bank with "⚙️ Settings"'}\n2. Send stablecoins, get cash fast.\n\nRates dey fresh, money dey safe!\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na your wallet).`
        : `👋 Welcome back, ${userState.firstName}!\n\nThis is **DirectPay**, your crypto-to-cash solution.\n\n💡 *Quick Start:*\n1. ${hasBankLinked ? 'View your wallet' : 'Link your bank in "⚙️ Settings"'}\n2. Send stablecoins, receive cash quickly.\n\nRates are updated, funds are secure!\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to your wallet).`
      : userState.usePidgin
        ? `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s start your crypto journey. Click "💼 View Wallet" to generate one!`
        : `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s begin your crypto journey. Click "💼 View Wallet" to generate one!`;

    if (adminUser) {
      const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
      ]));
      ctx.session.adminMessageId = sentMessage.message_id;
    } else {
      await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
    }
  } catch (error) {
    logger.error(`Error greeting user ${userId}: ${error.message}`);
    throw error;
  }
}

// =================== /balance Command ===================
bot.command('balance', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey. Click "💼 View Wallet" to generate one.'
        : '❌ No wallets yet. Click "💼 View Wallet" to generate one.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    let balanceMsg = userState.usePidgin
      ? `💰 *Your Wallet Balances*\n\n`
      : `💰 *Your Wallet Balances*\n\n`;
    let hasPending = false;

    for (const [index, wallet] of userState.wallets.entries()) {
      const balance = await getWalletBalance(wallet.address, wallet.chain);
      balanceMsg += `*Wallet ${index + 1} (${wallet.name || 'Unnamed'}) - ${wallet.chain}:*\n` +
                    `• *Address:* \`${wallet.address}\`\n` +
                    `• *USDC:* ${balance.USDC} USDC\n` +
                    `• *USDT:* ${balance.USDT} USDT\n` +
                    `• *Bank:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`;

      const pendingTxs = await db.collection('transactions')
        .where('userId', '==', userId)
        .where('walletAddress', '==', wallet.address)
        .where('status', '==', 'Pending')
        .get();
      if (!pendingTxs.empty) {
        hasPending = true;
        pendingTxs.forEach(doc => {
          const tx = doc.data();
          const potentialPayout = tx.payout || 'Pending rate update';
          balanceMsg += userState.usePidgin
            ? `  • *Pending Deposit:* ${tx.amount} ${tx.asset} (Ref: \`${tx.referenceId}\`)\n` +
              `    *Payout:* ${typeof potentialPayout === 'number' ? `₦${potentialPayout.toLocaleString()}` : potentialPayout}\n`
            : `  • *Pending Deposit:* ${tx.amount} ${tx.asset} (Ref: \`${tx.referenceId}\`)\n` +
              `    *Payout:* ${typeof potentialPayout === 'number' ? `₦${potentialPayout.toLocaleString()}` : potentialPayout}\n`;
        });
      }
    }

    if (hasPending && !userState.wallets.every(w => w.bank)) {
      balanceMsg += userState.usePidgin
        ? `\n⚠️ You get pending deposits! Link bank in "⚙️ Settings" to cash out fast.`
        : `\n⚠️ You have pending deposits! Link a bank in "⚙️ Settings" to withdraw quickly.`;
    }

    await ctx.replyWithMarkdown(balanceMsg);
  } catch (error) {
    logger.error(`Error fetching balance for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error fetching balance for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Balance fetch or Firestore query failed.\n` +
      `*Action:* Check Blockradar API or Firestore status.`,
      { parse_mode: 'Markdown' }
    );
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Error checking balance. Try again later.'
      : '❌ Error fetching your balance. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== View Wallet Handler ===================
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      await generateAndShowWallet(ctx, userState);
    } else {
      await showWalletPage(ctx, userState, 1);
    }
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error in View Wallet for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Wallet generation or display failed.\n` +
      `*Action:* Check generateAndShowWallet or showWalletPage.`,
      { parse_mode: 'Markdown' }
    );
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ E no work. Try again later.'
      : '❌ Error fetching wallets. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

async function generateAndShowWallet(ctx, userState) {
  const userId = ctx.from.id.toString();
  const tempFilePath = path.join(__dirname, `temp_qr_${userId}_${Date.now()}.png`);
  try {
    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets (${MAX_WALLETS}). Check your wallets first.`
        : `⚠️ You’ve reached the max wallet limit (${MAX_WALLETS}). View your existing wallets first.`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    const chain = 'Base';
    const generatingMessage = await ctx.replyWithMarkdown(userState.usePidgin
      ? `🔄 Generating wallet for ${chain}. Wait small...`
      : `🔄 Generating your wallet on ${chain}. Please wait...`);

    const walletAddress = await generateWallet(chain);
    const newWallet = {
      address: walletAddress,
      chain: chain,
      supportedAssets: chains[chain].supportedAssets,
      bank: null,
      name: `Wallet ${userState.wallets.length + 1}`,
      creationDate: new Date().toISOString(),
      totalDeposits: 0,
      totalPayouts: 0
    };
    userState.wallets.push(newWallet);
    userState.walletAddresses.push(walletAddress);

    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses,
    });

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `💼 Wallet generated for user ${userId} on ${chain}: ${walletAddress}`,
      { parse_mode: 'Markdown' }
    );
    logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);

    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(walletAddress)}`;
    const qrCodeResponse = await axios.get(qrCodeUrl, { responseType: 'arraybuffer' });
    const qrCodeBuffer = Buffer.from(qrCodeResponse.data);

    if (!fs.existsSync(WALLET_GENERATED_IMAGE)) {
      throw new Error(`Base image not found at ${WALLET_GENERATED_IMAGE}`);
    }

    await sharp(WALLET_GENERATED_IMAGE)
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .composite([{ input: qrCodeBuffer, top: 250, left: 210 }])
      .png()
      .toFile(tempFilePath);

    const newWalletIndex = userState.wallets.length - 1;
    ctx.session.walletIndex = newWalletIndex;

    const successMsg = userState.usePidgin
      ? `✅ *Wallet Ready*\n\n` +
        `*Chain:* ${chain}\n` +
        `*Assets:* USDC, USDT\n` +
        `*Address:* \`${walletAddress}\`\n\n` +
        `Send USDC/USDT here. Link bank in "⚙️ Settings" to cash out!\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `✅ *Wallet Generated*\n\n` +
        `*Chain:* ${chain}\n` +
        `*Assets:* USDC, USDT\n` +
        `*Address:* \`${walletAddress}\`\n\n` +
        `Send USDC/USDT to this address. Link a bank in "⚙️ Settings" to withdraw!\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    await ctx.deleteMessage(generatingMessage.message_id);
    await ctx.replyWithPhoto({ source: createReadStream(tempFilePath) }, {
      caption: successMsg,
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🏦 Link Bank Now', `link_bank_${newWalletIndex}`)]
      ]).reply_markup
    });

    await unlinkAsync(tempFilePath);
    await showWalletPage(ctx, userState, 1);
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error generating wallet for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Wallet generation, QR code creation, or Firestore update failed.\n` +
      `*Action:* Check Blockradar API, image files, or Firestore status.`,
      { parse_mode: 'Markdown' }
    );
    const errorMsg = userState.usePidgin
      ? '❌ Problem creating wallet. Try again later.'
      : '❌ Error generating wallet. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    if (fs.existsSync(tempFilePath)) await unlinkAsync(tempFilePath).catch(e => logger.error(`Cleanup failed: ${e.message}`));
  }
}

async function showWalletPage(ctx, userState, page) {
  const userId = ctx.from.id.toString();
  const pageSize = 1;
  const totalPages = Math.max(1, Math.ceil(userState.wallets.length / pageSize));
  const adjustedPage = Math.min(Math.max(1, page), totalPages);
  const start = (adjustedPage - 1) * pageSize;
  const end = Math.min(start + pageSize, userState.wallets.length);
  const wallets = userState.wallets.slice(start, end);

  try {
    const timestamp = new Date().toISOString();
    let message = userState.usePidgin
      ? `💼 *Your Wallet* (Page ${adjustedPage}/${totalPages})\n*Updated:* ${timestamp}\n\n`
      : `💼 *Your Wallet* (Page ${adjustedPage}/${totalPages})\n*Updated:* ${timestamp}\n\n`;

    if (wallets.length === 0) {
      message += userState.usePidgin ? 'No wallets yet.' : 'No wallets yet.';
    } else {
      const wallet = wallets[0];
      const balance = await getWalletBalance(wallet.address, wallet.chain);
      message += userState.usePidgin
        ? `*Wallet ${start + 1} (${wallet.name || 'Unnamed'}):*\n` +
          `• *Address:* \`${wallet.address}\`\n` +
          `• *Chain:* ${wallet.chain}\n` +
          `• *USDC:* ${balance.USDC} USDC\n` +
          `• *USDT:* ${balance.USDT} USDT\n` +
          `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
          `• *Bank:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n` +
          `• *Total Deposits:* ${wallet.totalDeposits || 0} USDC/USDT\n`
        : `*Wallet ${start + 1} (${wallet.name || 'Unnamed'}):*\n` +
          `• *Address:* \`${wallet.address}\`\n` +
          `• *Chain:* ${wallet.chain}\n` +
          `• *USDC:* ${balance.USDC} USDC\n` +
          `• *USDT:* ${balance.USDT} USDT\n` +
          `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
          `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n` +
          `• *Total Deposits:* ${wallet.totalDeposits || 0} USDC/USDT\n`;
    }

    const navigationButtons = [];
    if (adjustedPage > 1) navigationButtons.push(Markup.button.callback('⬅️ Back', `wallet_page_${adjustedPage - 1}`));
    if (adjustedPage < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${adjustedPage + 1}`));
    navigationButtons.push(Markup.button.callback('🏦 Edit Bank', `link_bank_${start}`));
    navigationButtons.push(Markup.button.callback('🏠 Exit', 'wallet_exit'));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);
    if (ctx.session.walletMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.walletMessageId, null, message, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message, inlineKeyboard);
      ctx.session.walletMessageId = sentMessage.message_id;
    }
  } catch (error) {
    logger.error(`Error showing wallet page for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error showing wallet page for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Balance fetch or message rendering failed.\n` +
      `*Action:* Check Blockradar API or Telegram status.`,
      { parse_mode: 'Markdown' }
    );
    const errorMsg = userState.usePidgin
      ? '❌ Error showing wallet. Try again later.'
      : '❌ Error displaying wallet page. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
}

// Navigation actions for wallet pagination
bot.action(/wallet_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    await showWalletPage(ctx, userState, requestedPage);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating wallet page for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error navigating wallet page for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Pagination logic or display failed.\n` +
      `*Action:* Check showWalletPage or user data.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('⚠️ Error navigating page.');
  }
});

bot.action(/link_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (isNaN(walletIndex) || walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '⚠️ Wallet no dey. Check "💼 View Wallet" first.'
        : '⚠️ Invalid wallet selected. View your wallets first.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    ctx.session.walletIndex = walletIndex;
    await ctx.scene.enter('bank_linking_scene');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error entering bank linking for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error entering bank linking for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Scene entry or user state fetch failed.\n` +
      `*Action:* Check scene registration or Firestore status.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.replyWithMarkdown('❌ Error starting bank linking.');
    await ctx.answerCbQuery();
  }
});

bot.action('wallet_exit', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (ctx.session.walletMessageId) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.session.walletMessageId);
      delete ctx.session.walletMessageId;
    }
    const hasBankLinked = userState.wallets.some(w => w.bank);
    await ctx.replyWithMarkdown(userState.usePidgin ? '🏠 Back to main menu.' : '🏠 Returned to main menu.', getMainMenu(userState.wallets.length > 0, hasBankLinked));
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error exiting wallet view for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error exiting wallet view for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Message deletion or menu rendering failed.\n` +
      `*Action:* Check Telegram API status.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('❌ Error exiting wallet view.');
  }
});
// =================== Learn About Base Handler ===================
const learnAboutBaseContent = [
  {
    text: `*What is Base?*\n\nBase na layer-2 blockchain wey dey work with Ethereum. E dey fast, cheap, and secure for transactions like sending USDC/USDT. E dey help you save cost when you dey swap or move money!`,
    pidgin: `*Wetin be Base?*\n\nBase na layer-2 blockchain wey dey support Ethereum. E fast, cheap, and safe for sending USDC/USDT. E dey help you cut cost when you dey move money or swap!`
  },
  {
    text: `*Why Use Base?*\n\n- *Speed:* Transactions confirm sharp-sharp.\n- *Low Fees:* You no go pay plenty gas fees.\n- *Security:* Backed by Ethereum, so e strong.\nPerfect for quick crypto-to-cash like DirectPay!`,
    pidgin: `*Why Base?*\n\n- *Speed:* Transactions dey confirm fast.\n- *Low Fees:* You no go spend much for gas.\n- *Security:* Ethereum dey back am, so e tight.\nE good for fast crypto-to-cash like DirectPay!`
  },
  {
    text: `*How Base Works with DirectPay?*\n\nSend USDC/USDT to your Base wallet here, we process am quick, and you get Naira for your bank. Simple, fast, and reliable! Check "💼 View Wallet" to start.`,
    pidgin: `*How Base dey work with DirectPay?*\n\nSend USDC/USDT come your Base wallet here, we go process am sharp, you collect Naira for your bank. Simple, fast, and sure! Check "💼 View Wallet" to start.`
  }
];

bot.hears('📘 Learn About Base', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    await showLearnAboutBasePage(ctx, userState, 1);
  } catch (error) {
    logger.error(`Error starting Learn About Base for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error starting Learn About Base for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* User state fetch or page display failed.\n` +
      `*Action:* Check Firestore or showLearnAboutBasePage.`,
      { parse_mode: 'Markdown' }
    );
    const errorMsg = userState.usePidgin
      ? '❌ Error loading Base info. Try again later.'
      : '❌ Error loading Base information. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

async function showLearnAboutBasePage(ctx, userState, page) {
  const userId = ctx.from.id.toString();
  const totalPages = learnAboutBaseContent.length;
  const adjustedPage = Math.min(Math.max(1, page), totalPages);

  try {
    const content = learnAboutBaseContent[adjustedPage - 1];
    const message = userState.usePidgin
      ? `${content.pidgin}\n\n*Page ${adjustedPage}/${totalPages}*`
      : `${content.text}\n\n*Page ${adjustedPage}/${totalPages}*`;

    const navigationButtons = [];
    if (adjustedPage > 1) navigationButtons.push(Markup.button.callback('⬅️ Back', `learn_base_page_${adjustedPage - 1}`));
    if (adjustedPage < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `learn_base_page_${adjustedPage + 1}`));
    navigationButtons.push(Markup.button.callback('🏠 Exit', 'learn_base_exit'));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);
    if (ctx.session.learnBaseMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.learnBaseMessageId, null, message, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message, inlineKeyboard);
      ctx.session.learnBaseMessageId = sentMessage.message_id;
    }
  } catch (error) {
    logger.error(`Error showing Learn About Base page for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error showing Learn About Base page for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Message rendering or Telegram API failed.\n` +
      `*Action:* Check Telegram status or content data.`,
      { parse_mode: 'Markdown' }
    );
    const errorMsg = userState.usePidgin
      ? '❌ Error showing page. Try again later.'
      : '❌ Error displaying page. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
}

bot.action(/learn_base_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    await showLearnAboutBasePage(ctx, userState, requestedPage);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating Learn About Base page for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error navigating Learn About Base page for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Pagination or display failed.\n` +
      `*Action:* Check showLearnAboutBasePage or user data.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery(userState.usePidgin ? '⚠️ Page no dey.' : '⚠️ Error navigating page.');
  }
});

bot.action('learn_base_exit', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (ctx.session.learnBaseMessageId) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.session.learnBaseMessageId);
      delete ctx.session.learnBaseMessageId;
    }
    const hasBankLinked = userState.wallets.some(w => w.bank);
    await ctx.replyWithMarkdown(userState.usePidgin ? '🏠 Back to main menu.' : '🏠 Returned to main menu.', getMainMenu(userState.wallets.length > 0, hasBankLinked));
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error exiting Learn About Base for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error exiting Learn About Base for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Message deletion or menu rendering failed.\n` +
      `*Action:* Check Telegram API status.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('❌ Error exiting Learn About Base.');
  }
});

// =================== Webhook Handlers ===================
async function handlePaycrestWebhook(req, res) {
  const signatureHeader = req.headers['x-paycrest-signature'];
  const rawBody = req.body.toString();

  try {
    if (!verifyPaycrestSignature(rawBody, signatureHeader, PAYCREST_CLIENT_SECRET)) {
      logger.error('Paycrest webhook signature verification failed.');
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
        `❗️ Paycrest webhook signature verification failed:\n` +
        `*Signature Received:* ${signatureHeader}\n` +
        `*Cause:* Invalid or tampered webhook request.\n` +
        `*Action:* Verify PAYCREST_CLIENT_SECRET or check Paycrest configuration.`,
        { parse_mode: 'Markdown' }
      );
      return res.status(401).send('Invalid signature');
    }

    const payload = JSON.parse(rawBody);
    const { orderId, status, amount, token, network, recipient, transactionHash } = payload;

    const txSnapshot = await db.collection('transactions')
      .where('paycrestOrderId', '==', orderId)
      .limit(1)
      .get();

    if (txSnapshot.empty) {
      logger.warn(`No transaction found for Paycrest orderId: ${orderId}`);
      return res.status(404).send('Transaction not found');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userState = await getUserState(userId);

    if (status === 'completed') {
      const payoutAmount = calculatePayout(token, amount);
      await db.collection('transactions').doc(txDoc.id).update({
        status: 'Completed',
        payout: payoutAmount,
        transactionHash,
        updatedAt: new Date().toISOString()
      });

      const walletIndex = userState.wallets.findIndex(w => w.address === txData.walletAddress);
      if (walletIndex !== -1) {
        userState.wallets[walletIndex].totalPayouts = (userState.wallets[walletIndex].totalPayouts || 0) + payoutAmount;
        await updateUserState(userId, { wallets: userState.wallets });
      }

      const successMsg = userState.usePidgin
        ? `✅ *Payment Don Settle*\n\n` +
          `*Amount:* ${amount} ${token}\n` +
          `*Payout:* ₦${payoutAmount.toLocaleString()}\n` +
          `*Bank:* ${recipient.accountName} (****${recipient.accountIdentifier.slice(-4)})\n` +
          `*Tx Hash:* \`${transactionHash}\`\n` +
          `*Ref:* ${txData.referenceId}\n\n` +
          `Money don land your account!`
        : `✅ *Payment Settled*\n\n` +
          `*Amount:* ${amount} ${token}\n` +
          `*Payout:* ₦${payoutAmount.toLocaleString()}\n` +
          `*Bank:* ${recipient.accountName} (****${recipient.accountIdentifier.slice(-4)})\n` +
          `*Tx Hash:* \`${transactionHash}\`\n` +
          `*Ref:* ${txData.referenceId}\n\n` +
          `Funds have been credited to your account!`;
      await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, { caption: successMsg, parse_mode: 'Markdown' });

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
        `💸 Payout completed for user ${userId}:\n` +
        `*Amount:* ${amount} ${token}\n` +
        `*Payout:* ₦${payoutAmount.toLocaleString()}\n` +
        `*Bank:* ${recipient.accountName} (****${recipient.accountIdentifier.slice(-4)})\n` +
        `*Tx Hash:* ${transactionHash}`,
        { parse_mode: 'Markdown' }
      );
    } else if (status === 'failed') {
      await db.collection('transactions').doc(txDoc.id).update({
        status: 'Failed',
        updatedAt: new Date().toISOString()
      });

      const refundAddress = userState.refundAddress || txData.walletAddress;
      const refundMsg = userState.usePidgin
        ? `❌ *Payout Fail*\n\n` +
          `*Amount:* ${amount} ${token}\n` +
          `*Ref:* ${txData.referenceId}\n\n` +
          `We don send ${amount} ${token} back to \`${refundAddress}\`. Check am!`
        : `❌ *Payout Failed*\n\n` +
          `*Amount:* ${amount} ${token}\n` +
          `*Ref:* ${txData.referenceId}\n\n` +
          `We’ve refunded ${amount} ${token} to \`${refundAddress}\`. Please check!`;
      await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, { caption: refundMsg, parse_mode: 'Markdown' });
    }

    res.status(200).send('Webhook processed');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error processing Paycrest webhook:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Parsing, Firestore update, or Telegram messaging failed.\n` +
      `*Action:* Check payload format, Firestore, or Telegram status.`,
      { parse_mode: 'Markdown' }
    );
    res.status(500).send('Internal server error');
  }
}

app.post(WEBHOOK_BLOCKRADAR_PATH, async (req, res) => {
  try {
    const payload = req.body;
    const { address, assetId, amount, chain, transactionHash, reference } = payload;

    const userSnapshot = await db.collection('users')
      .where('walletAddresses', 'array-contains', address)
      .limit(1)
      .get();

    if (userSnapshot.empty) {
      logger.warn(`No user found for wallet address: ${address}`);
      return res.status(404).send('User not found');
    }

    const userDoc = userSnapshot.docs[0];
    const userId = userDoc.id;
    const userState = userDoc.data();

    const chainKey = chainMapping[chain.toLowerCase()] || chain;
    const chainData = chains[chainKey];
    const asset = Object.keys(chainData.assets).find(key => chainData.assets[key] === assetId);
    if (!asset) throw new Error(`Unknown assetId: ${assetId}`);

    const walletIndex = userState.wallets.findIndex(w => w.address === address);
    if (walletIndex === -1) throw new Error(`Wallet ${address} not found in user state`);

    userState.wallets[walletIndex].totalDeposits = (userState.wallets[walletIndex].totalDeposits || 0) + parseFloat(amount);
    await updateUserState(userId, { wallets: userState.wallets });

    const referenceId = reference || generateReferenceId();
    const txData = {
      userId,
      walletAddress: address,
      chain: chainKey,
      asset,
      amount: parseFloat(amount),
      referenceId,
      status: 'Pending',
      createdAt: new Date().toISOString(),
      transactionHash
    };

    const txRef = await db.collection('transactions').add(txData);

    const depositMsg = userState.usePidgin
      ? `✅ *Deposit Don Land*\n\n` +
        `*Amount:* ${amount} ${asset}\n` +
        `*Wallet:* \`${address}\`\n` +
        `*Chain:* ${chainKey}\n` +
        `*Tx Hash:* \`${transactionHash}\`\n` +
        `*Ref:* ${referenceId}\n\n` +
        `${userState.wallets[walletIndex].bank ? 'We dey process your payout now!' : 'Link bank in "⚙️ Settings" to cash out!'}`
      : `✅ *Deposit Received*\n\n` +
        `*Amount:* ${amount} ${asset}\n` +
        `*Wallet:* \`${address}\`\n` +
        `*Chain:* ${chainKey}\n` +
        `*Tx Hash:* \`${transactionHash}\`\n` +
        `*Ref:* ${referenceId}\n\n` +
        `${userState.wallets[walletIndex].bank ? 'We’re processing your payout now!' : 'Link a bank in "⚙️ Settings" to withdraw!'} `;
    await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, { caption: depositMsg, parse_mode: 'Markdown' });

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `💰 Deposit received for user ${userId}:\n` +
      `*Amount:* ${amount} ${asset}\n` +
      `*Wallet:* ${address}\n` +
      `*Chain:* ${chainKey}\n` +
      `*Tx Hash:* ${transactionHash}`,
      { parse_mode: 'Markdown' }
    );

    if (userState.wallets[walletIndex].bank) {
      const recipientDetails = userState.wallets[walletIndex].bank;
      const orderData = await createPaycrestOrder(userId, amount, asset, chainKey, recipientDetails, address);
      await db.collection('transactions').doc(txRef.id).update({
        paycrestOrderId: orderData.orderId,
        status: 'Processing'
      });

      const processingMsg = userState.usePidgin
        ? `🔄 *Payout Dey Process*\n\n` +
          `*Amount:* ${amount} ${asset}\n` +
          `*Payout:* ₦${calculatePayout(asset, amount).toLocaleString()}\n` +
          `*Bank:* ${recipientDetails.bankName} (****${recipientDetails.accountNumber.slice(-4)})\n` +
          `*Ref:* ${referenceId}`
        : `🔄 *Payout Processing*\n\n` +
          `*Amount:* ${amount} ${asset}\n` +
          `*Payout:* ₦${calculatePayout(asset, amount).toLocaleString()}\n` +
          `*Bank:* ${recipientDetails.bankName} (****${recipientDetails.accountNumber.slice(-4)})\n` +
          `*Ref:* ${referenceId}`;
      await bot.telegram.sendMessage(userId, processingMsg, { parse_mode: 'Markdown' });

      await withdrawFromBlockradar(chainKey, chainData.assets[asset], orderData.senderAddress, amount, referenceId, { orderId: orderData.orderId });
    }

    res.status(200).send('Webhook processed');
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error processing Blockradar webhook:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Payload parsing, Firestore update, or payout processing failed.\n` +
      `*Action:* Check payload format, Firestore, or Blockradar/Paycrest APIs.`,
      { parse_mode: 'Markdown' }
    );
    res.status(500).send('Internal server error');
  }
});

// =================== Settings Handlers ===================
bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const settingsMsg = userState.usePidgin
      ? '⚙️ *Settings*\n\nPick option wey you want:'
      : '⚙️ *Settings*\n\nChoose an option below:';
    await ctx.replyWithMarkdown(settingsMsg, getSettingsMenu());
  } catch (error) {
    logger.error(`Error showing settings for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error showing settings for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* User state fetch or message sending failed.\n` +
      `*Action:* Check Firestore or Telegram API.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.replyWithMarkdown('❌ Error loading settings. Try again later.');
  }
});

bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    await generateAndShowWallet(ctx, userState);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error generating new wallet from settings for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error generating wallet from settings for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Wallet generation logic failed.\n` +
      `*Action:* Check generateAndShowWallet function.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('❌ Error generating wallet.');
  }
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey to edit bank. Create one first.'
        : '❌ No wallets to edit bank for. Create one first.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }
    await showWalletPage(ctx, userState, 1);
    await ctx.answerCbQuery('Select a wallet to edit bank.');
  } catch (error) {
    logger.error(`Error editing bank from settings for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error editing bank from settings for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Wallet display or user state fetch failed.\n` +
      `*Action:* Check showWalletPage or Firestore status.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('❌ Error loading wallets to edit bank.');
  }
});

// Placeholder for other settings actions (implement as needed)
bot.action('settings_rename_wallet', async (ctx) => { await ctx.answerCbQuery('Not implemented yet.'); });
bot.action('settings_set_refund_address', async (ctx) => { await ctx.answerCbQuery('Not implemented yet.'); });
bot.action('settings_support', async (ctx) => { await ctx.answerCbQuery('Contact @maxcswap for support.'); });
bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const hasBankLinked = userState.wallets.some(w => w.bank);
    await ctx.editMessageText(userState.usePidgin ? '🏠 Back to main menu.' : '🏠 Returned to main menu.', {
      parse_mode: 'Markdown',
      reply_markup: getMainMenu(userState.wallets.length > 0, hasBankLinked).reply_markup
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error returning to main menu for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error returning to main menu for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Message edit or user state fetch failed.\n` +
      `*Action:* Check Telegram API or Firestore status.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('❌ Error returning to main menu.');
  }
});

// =================== Admin Panel ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    if (!isAdmin(userId)) {
      await ctx.answerCbQuery('❌ You no be admin.');
      return;
    }
    await ctx.editMessageText('🔧 *Admin Panel*\n\nChoose an option:', {
      parse_mode: 'Markdown',
      reply_markup: getAdminMenu().reply_markup
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error opening admin panel for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error opening admin panel for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Message edit or admin check failed.\n` +
      `*Action:* Check Telegram API or ADMIN_IDS.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('❌ Error opening admin panel.');
  }
});

bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    if (!isAdmin(userId)) {
      await ctx.answerCbQuery('❌ You no be admin.');
      return;
    }
    await ctx.scene.enter('send_message_scene');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error entering send message scene for admin ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error entering send message scene for admin ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Scene entry failed.\n` +
      `*Action:* Check scene registration or Telegram status.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('❌ Error starting message process.');
  }
});

bot.action('admin_back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const hasBankLinked = userState.wallets.some(w => w.bank);
    await ctx.editMessageText(userState.usePidgin ? '🏠 Back to main menu.' : '🏠 Returned to main menu.', {
      parse_mode: 'Markdown',
      reply_markup: getMainMenu(userState.wallets.length > 0, hasBankLinked).reply_markup
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error returning to main menu from admin for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error returning to main menu from admin for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Message edit or user state fetch failed.\n` +
      `*Action:* Check Telegram API or Firestore status.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('❌ Error returning to main menu.');
  }
});

// Placeholder for other admin actions (implement as needed)
bot.action('admin_view_all_transactions', async (ctx) => { await ctx.answerCbQuery('Not implemented yet.'); });
bot.action('admin_view_users', async (ctx) => { await ctx.answerCbQuery('Not implemented yet.'); });
bot.action('admin_pending_issues', async (ctx) => { await ctx.answerCbQuery('Not implemented yet.'); });
bot.action('admin_manual_payout', async (ctx) => { await ctx.answerCbQuery('Not implemented yet.'); });
bot.action('admin_refund_tx', async (ctx) => { await ctx.answerCbQuery('Not implemented yet.'); });
bot.action('admin_api_status', async (ctx) => { await ctx.answerCbQuery('Not implemented yet.'); });

// =================== Other Handlers ===================
bot.hears('💰 Transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const txSnapshot = await db.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();

    let txMsg = userState.usePidgin
      ? `💰 *Your Last Transactions*\n\n`
      : `💰 *Your Recent Transactions*\n\n`;
    if (txSnapshot.empty) {
      txMsg += userState.usePidgin ? 'No transactions yet.' : 'No transactions yet.';
    } else {
      txSnapshot.forEach(doc => {
        const tx = doc.data();
        txMsg += userState.usePidgin
          ? `- *${tx.amount} ${tx.asset}* (${tx.status})\n` +
            `  *Ref:* ${tx.referenceId}\n` +
            `  *Date:* ${new Date(tx.createdAt).toLocaleDateString()}\n\n`
          : `- *${tx.amount} ${tx.asset}* (${tx.status})\n` +
            `  *Ref:* ${tx.referenceId}\n` +
            `  *Date:* ${new Date(tx.createdAt).toLocaleDateString()}\n\n`;
      });
    }
    await ctx.replyWithMarkdown(txMsg);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error fetching transactions for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Firestore query or message sending failed.\n` +
      `*Action:* Check Firestore status or Telegram API.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.replyWithMarkdown('❌ Error loading transactions. Try again later.');
  }
});

bot.hears('ℹ️ Support', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const supportMsg = userState.usePidgin
      ? '💬 *Support*\n\nYou fit reach us for [@maxcswap](https://t.me/maxcswap) if you get any wahala!'
      : '💬 *Support*\n\nContact us at [@maxcswap](https://t.me/maxcswap) for any issues!';
    await ctx.replyWithMarkdown(supportMsg);
  } catch (error) {
    logger.error(`Error showing support for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error showing support for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Message sending failed.\n` +
      `*Action:* Check Telegram API status.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.replyWithMarkdown('❌ Error loading support info.');
  }
});

bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const ratesMsg = userState.usePidgin
      ? `📈 *Current Rates*\n\n` +
        `*USDC:* ₦${exchangeRates.USDC?.toLocaleString() || 'Loading...'}/USDC\n` +
        `*USDT:* ₦${exchangeRates.USDT?.toLocaleString() || 'Loading...'}/USDT\n\n` +
        `Rates dey update every 15 mins!`
      : `📈 *Current Rates*\n\n` +
        `*USDC:* ₦${exchangeRates.USDC?.toLocaleString() || 'Loading...'}/USDC\n` +
        `*USDT:* ₦${exchangeRates.USDT?.toLocaleString() || 'Loading...'}/USDT\n\n` +
        `Rates are refreshed every 15 minutes!`;
    await ctx.replyWithMarkdown(ratesMsg);
  } catch (error) {
    logger.error(`Error showing rates for user ${userId}: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
      `❗️ Error showing rates for user ${userId}:\n` +
      `*Error:* ${error.message}\n` +
      `*Cause:* Rate fetch or message sending failed.\n` +
      `*Action:* Check exchangeRates or Telegram API.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.replyWithMarkdown('❌ Error loading rates. Try again later.');
  }
});

// =================== Start Express Server ===================
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
    `❗️ Uncaught Exception:\n` +
    `*Error:* ${error.message}\n` +
    `*Stack:* ${error.stack}\n` +
    `*Cause:* Unexpected error in code.\n` +
    `*Action:* Review logs and restart bot.`,
    { parse_mode: 'Markdown' }
  );
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  await bot.telegram.sendMessage(PERSONAL_CHAT_ID, 
    `❗️ Unhandled Rejection:\n` +
    `*Reason:* ${reason}\n` +
    `*Cause:* Unhandled promise error.\n` +
    `*Action:* Check promise handling in code.`,
    { parse_mode: 'Markdown' }
  );
});
