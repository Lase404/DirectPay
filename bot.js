const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const bodyParser = require('body-parser');
const sharp = require('sharp');
const requestIp = require('request-ip');
require('dotenv').config();

// =================== Logger Setup ===================
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
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
  BOT_TOKEN,
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

if (!BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY) {
  logger.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

// =================== Image Paths ===================
const WALLET_GENERATED_IMAGE = './wallet_generated_base.png';
const DEPOSIT_SUCCESS_IMAGE = './deposit_success.png';
const PAYOUT_SUCCESS_IMAGE = './payout_success.png';
const ERROR_IMAGE = './error.png';

// =================== Initialize Express App ===================
const app = express();

// =================== Initialize Telegraf Bot ===================
const bot = new Telegraf(BOT_TOKEN);

// =================== Define Supported Banks ===================
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
  { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'], paycrestInstitutionCode: 'KUDANGPC' },
  { name: 'OPay', code: '999992', aliases: ['opay', 'opay nigeria'], paycrestInstitutionCode: 'OPAYNGPC' },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'], paycrestInstitutionCode: 'PALMNGPC' },
  { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack mfb', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
  { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint', 'moniepoint mfb', 'moniepoint nigeria'], paycrestInstitutionCode: 'MONINGPC' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'], paycrestInstitutionCode: 'ZENITHNGLA' },
  { name: 'GTBank', code: '058', aliases: ['gtbank', 'gt bank', 'gtb', 'gt bank nigeria'], paycrestInstitutionCode: 'GTBNGLA' },
  { name: 'First Bank of Nigeria', code: '011', aliases: ['first bank', 'first bank of nigeria', 'fbn', 'firstbank'], paycrestInstitutionCode: 'FBNNGLA' },
  { name: 'UBA', code: '032', aliases: ['uba', 'united bank for africa', 'uba nigeria'], paycrestInstitutionCode: 'UBANGPC' },
  { name: 'FCMB', code: '214', aliases: ['fcmb', 'first city monument bank', 'fcmb nigeria'], paycrestInstitutionCode: 'FCMBNGPC' },
];

// =================== Define Supported Chains ===================
const chains = {
  Base: {
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: BLOCKRADAR_BASE_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Base',
    assets: {
      USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
      USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
    }
  },
  Polygon: {
    id: 'f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a',
    key: BLOCKRADAR_POLYGON_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon',
    assets: {
      USDC: 'f348e8e3-e0b4-4704-857e-c274ef000c00',
      USDT: 'c9d57a33-375b-46f7-b694-16e9b498e0e1',
    }
  },
  'BNB Smart Chain': {
    id: '7a844e91-5740-4589-9695-c74411adec7e',
    key: BLOCKRADAR_BNB_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain',
    assets: {
      USDC: 'ff479231-0dbb-4760-b695-e219a50934af',
      USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb',
    }
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
    logger.error(`No mapping found for chain name: ${chainName}`);
    return null;
  }
  if (/polygon/i.test(chainKey)) network = 'polygon';
  else if (/base/i.test(chainKey)) network = 'base';
  else if (/bnb-smart-chain/i.test(chainKey)) network = 'bnb-smart-chain';
  else return null;
  return { token, network };
}

function calculatePayoutWithFee(amount, rate, feePercent = 0.5) {
  const fee = (amount * rate) * (feePercent / 100);
  return parseFloat(((amount * rate) - fee).toFixed(2));
}

function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

async function verifyBankAccount(accountNumber, bankCode) {
  try {
    logger.debug(`Verifying bank account ${accountNumber} for bank code ${bankCode}`);
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    logger.debug('Bank account verification successful.');
    return response.data;
  } catch (error) {
    logger.error(`Error verifying bank account: ${error.response ? error.response.data.message : error.message}`);
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
    logger.debug(`Creating Paycrest order for user ${userId}`);
    const paycrestMapping = mapToPaycrest(token, network);
    if (!paycrestMapping) {
      throw new Error('No Paycrest mapping for the selected asset/chain.');
    }
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
    if (!rate) {
      throw new Error(`Exchange rate for ${token} not available.`);
    }
    const orderPayload = {
      amount: String(amount),
      rate: String(rate),
      network: paycrestMapping.network,
      token: paycrestMapping.token,
      recipient: recipient,
      returnAddress: userSendAddress || PAYCREST_RETURN_ADDRESS,
      feePercent: 2,
    };
    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    if (orderResp.data.status !== 'success') {
      throw new Error(`Paycrest order creation failed: ${orderResp.data.message}`);
    }
    logger.debug(`Paycrest order created successfully for user ${userId}`);
    return orderResp.data.data;
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.response ? err.response.data.message : err.message}`);
    throw new Error('Failed to create Paycrest order.');
  }
}

async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    logger.debug(`Withdrawing from Blockradar on chain ${chain}`);
    const chainKey = chainMapping[chain.toLowerCase()];
    if (!chainKey) {
      throw new Error(`Unsupported or unknown chain: ${chain}`);
    }
    const chainData = chains[chainKey];
    if (!chainData) {
      throw new Error(`Chain data not found for: ${chainKey}`);
    }
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
    if (data.statusCode !== 200) {
      throw new Error(`Blockradar withdrawal error: ${JSON.stringify(data)}`);
    }
    logger.debug(`Withdrawal from Blockradar successful for chain ${chain}`);
    return data;
  } catch (error) {
    logger.error(`Error withdrawing from Blockradar: ${error.response ? error.response.data.message : error.message}`);
    throw error;
  }
}

async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      await db.collection('users').doc(userId).set({
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        usePidgin: false,
      });
      return {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        usePidgin: false,
      };
    } else {
      const data = userDoc.data();
      return {
        firstName: data.firstName || '',
        wallets: data.wallets || [],
        walletAddresses: data.walletAddresses || [],
        hasReceivedDeposit: data.hasReceivedDeposit || false,
        awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
        usePidgin: data.usePidgin || false,
      };
    }
  } catch (error) {
    logger.error(`Error getting user state for ${userId}: ${error.message}`);
    throw error;
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
    logger.debug(`Generating wallet for chain: ${chain}`);
    const chainData = chains[chain];
    if (!chainData) {
      throw new Error(`Unsupported chain: ${chain}`);
    }
    const response = await axios.post(
      chainData.apiUrl,
      { name: `DirectPay_User_Wallet_${chain}` },
      { headers: { 'x-api-key': chainData.key } }
    );
    const walletAddress = response.data.data.address;
    if (!walletAddress) {
      throw new Error('Wallet address not returned from Blockradar.');
    }
    logger.debug(`Wallet generated: ${walletAddress}`);
    return walletAddress;
  } catch (error) {
    logger.error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
    throw new Error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
  }
}

// =================== Dynamic Main Menu ===================
// If a user already has wallet(s), show "💼 View Wallet" instead of "💼 Generate Wallet".
const getMainMenu = (userState) => {
  if (userState && userState.wallets && userState.wallets.length > 0) {
    return Markup.keyboard([
      ['💼 View Wallet', '⚙️ Settings'],
      ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
      ['📈 View Current Rates']
    ]).resize();
  } else {
    return Markup.keyboard([
      ['💼 Generate Wallet', '⚙️ Settings'],
      ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
      ['📈 View Current Rates']
    ]).resize();
  }
};

// =================== Check if User is Admin ===================
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

// =================== /start Command ===================
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

async function greetUser(ctx) {
  try {
    const userId = ctx.from.id.toString();
    let userState = await getUserState(userId);
    if (!userState.firstName && ctx.from.first_name) {
      await updateUserState(userId, { firstName: ctx.from.first_name });
      userState.firstName = ctx.from.first_name;
    }
    const greeting = userState.firstName
      ? `👋 Welcome, ${userState.firstName}!\n\nThank you for choosing **DirectPay**.`
      : `👋 Welcome, valued user!\n\nThank you for choosing **DirectPay**.`;
    const mainMenu = getMainMenu(userState);
    await ctx.replyWithMarkdown(greeting, { reply_markup: mainMenu.reply_markup });
    const location = ctx.session?.location || 'Nigeria';
    if (location === 'Nigeria' && !userState.usePidgin) {
      await ctx.reply('By the way, you seem to be in Nigeria. Want to switch to Pidgin? Just say "Pidgin" anytime!');
    }
    if (isAdmin(userId)) {
      const adminText = userState.firstName
        ? `Admin options, ${userState.firstName}:`
        : 'Admin options, esteemed user:';
      await ctx.reply(adminText, Markup.inlineKeyboard([[Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]]));
    }
  } catch (error) {
    logger.error(`Error in greetUser: ${error.message}`);
    throw error;
  }
}

// -------------------- Minimal Handlers for Support and Learn About Base --------------------
bot.hears('ℹ️ Support', async (ctx) => {
  try {
    await ctx.replyWithMarkdown('ℹ️ *Support*\nPlease contact our support team at [@DirectPaySupport](https://t.me/DirectPaySupport) for assistance.');
  } catch (error) {
    logger.error(`Error handling Support: ${error.message}`);
  }
});

bot.hears('📘 Learn About Base', async (ctx) => {
  try {
    await ctx.replyWithMarkdown('📘 *Learn About Base*\nBase is a secure and developer-friendly Ethereum Layer 2 network. For more details, visit [Base Docs](https://docs.base.org).');
  } catch (error) {
    logger.error(`Error handling Learn About Base: ${error.message}`);
  }
});

// Handle Pidgin switch
bot.hears('Pidgin', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    await updateUserState(userId, { usePidgin: true });
    const userState = await getUserState(userId);
    const confirmMsg = userState.firstName
      ? `Ehen! ${userState.firstName}, we don switch to Pidgin! Enjoy the full Naija vibe.`
      : `Ehen! We don switch to Pidgin for you o! Enjoy the Naija gist.`;
    const mainMenu = getMainMenu(userState);
    await ctx.replyWithMarkdown(confirmMsg, { reply_markup: mainMenu.reply_markup });
    if (isAdmin(userId)) {
      const adminText = userState.firstName
        ? `Admin options, ${userState.firstName} the boss:`
        : `Admin options, big boss:`;
      await ctx.reply(adminText, Markup.inlineKeyboard([[Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]]));
    }
  } catch (error) {
    logger.error(`Error switching to Pidgin for ${ctx.from.id}: ${error.message}`);
  }
});

// =================== Generate Wallet / View Wallet Handler ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    let userState = await getUserState(userId);
    // If user already has wallet(s), redirect to "View Wallet" instead.
    if (userState.wallets.length > 0) {
      return bot.hears('💼 View Wallet')(ctx);
    }
    const pendingMsg = userState.usePidgin
      ? '🔄 *Generating Wallet...* Hold tight!'
      : '🔄 *Generating Wallet...* Please wait!';
    const pendingMessage = await ctx.replyWithMarkdown(pendingMsg);
    const chain = 'Base';
    const walletAddress = await generateWallet(chain);
    userState.wallets.push({
      address: walletAddress,
      chain: chain,
      supportedAssets: ['USDC', 'USDT'],
      bank: null,
      amount: 0,
      creationDate: new Date().toISOString(),
      totalDeposits: 0,
      totalPayouts: 0
    });
    userState.walletAddresses.push(walletAddress);
    await updateUserState(userId, { wallets: userState.wallets, walletAddresses: userState.walletAddresses });
    await ctx.deleteMessage(pendingMessage.message_id);
    const successMsg = userState.usePidgin
      ? `✅ *Wallet Generated!*\n\nSupported Networks: Base, BNB Smart Chain, Polygon\nAssets: USDC, USDT\n\nAbeg link your bank account.`
      : `✅ *Wallet Generated!*\n\nSupported Networks: Base, BNB Smart Chain, Polygon\nAssets: USDC, USDT\n\nPlease link your bank account. Only USDC/USDT are accepted.`;
    await ctx.replyWithMarkdown(successMsg);
    // Immediately force bank linking
    ctx.session.walletIndex = userState.wallets.length - 1;
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet: ${error.message}`);
    const userState = await getUserState(ctx.from.id.toString());
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later.'
      : '⚠️ Error generating wallet. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// -------------------- Wallet Management: View Wallets --------------------
bot.hears('💼 View Wallet', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ You no get wallet o! Generate one with "💼 Generate Wallet".'
        : '❌ No wallets found. Please generate one first.';
      return ctx.replyWithMarkdown(errorMsg);
    }
    let message = userState.usePidgin
      ? '*Your Wallets:*\n\n'
      : '*Your Wallets:*\n\n';
    const inlineButtons = [];
    userState.wallets.forEach((wallet, index) => {
      const label = wallet.label || `Wallet #${index + 1}`;
      message += `• *${label}*\n   - ${wallet.address}\n   - ${wallet.chain}\n   - Deposits: ${wallet.totalDeposits || 0} | Payouts: ₦${wallet.totalPayouts || 0}\n   - Bank: ${wallet.bank ? 'Yes' : 'No'}\n\n`;
      // Split inline buttons into two rows:
      inlineButtons.push([
        Markup.button.callback('View Details', `view_wallet_${index}`),
        Markup.button.callback('Rename', `rename_wallet_${index}`)
      ]);
      inlineButtons.push([
        Markup.button.callback('Edit Bank', `edit_bank_wallet_${index}`),
        Markup.button.callback('Delete', `delete_wallet_${index}`)
      ]);
    });
    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(inlineButtons));
  } catch (error) {
    logger.error(`Error in View Wallet: ${error.message}`);
    const userState = await getUserState(ctx.from.id.toString());
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later.'
      : '⚠️ Error fetching wallets. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// Callback: View Wallet Details
bot.action(/^view_wallet_(\d+)$/, async (ctx) => {
  try {
    const index = parseInt(ctx.match[1], 10);
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const wallet = userState.wallets[index];
    if (!wallet) {
      return ctx.answerCbQuery('Wallet not found.', { show_alert: true });
    }
    let details = `*Wallet Details - ${wallet.label || `Wallet #${index + 1}`}*\n\n`;
    details += `• Address: ${wallet.address}\n• Network: ${wallet.chain}\n• Created: ${new Date(wallet.creationDate).toLocaleString()}\n• Deposits: ${wallet.totalDeposits || 0}\n• Payouts: ₦${wallet.totalPayouts || 0}\n`;
    details += wallet.bank
      ? `• Bank: ${wallet.bank.bankName}\n   - Acc: ****${wallet.bank.accountNumber.slice(-4)}\n   - Holder: ${wallet.bank.accountName}\n`
      : '• Bank: Not linked\n';
    // Fetch a count of transactions (for brevity)
    const txSnapshot = await db.collection('transactions').where('walletAddress', '==', wallet.address).get();
    details += `\n*Transactions:* ${txSnapshot.size}`;
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh', `view_wallet_${index}`)],
      [Markup.button.callback('🔙 Back', 'view_wallets_back')]
    ]);
    await ctx.editMessageText(details, { parse_mode: 'Markdown', reply_markup: buttons.reply_markup });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error viewing wallet details: ${error.message}`);
    await ctx.answerCbQuery('Error fetching wallet details.', { show_alert: true });
  }
});

bot.action('view_wallets_back', async (ctx) => {
  try {
    await bot.hears('💼 View Wallet')(ctx);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error going back to wallet view: ${error.message}`);
    await ctx.answerCbQuery();
  }
});

// Callback: Rename Wallet
bot.action(/^rename_wallet_(\d+)$/, async (ctx) => {
  try {
    const index = parseInt(ctx.match[1], 10);
    ctx.session.renameWalletIndex = index;
    await ctx.scene.enter('rename_wallet_scene');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error initiating wallet rename: ${error.message}`);
    await ctx.answerCbQuery();
  }
});

// Callback: Delete Wallet
bot.action(/^delete_wallet_(\d+)$/, async (ctx) => {
  try {
    const index = parseInt(ctx.match[1], 10);
    const confirmKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Yes, Delete', `confirm_delete_wallet_${index}`)],
      [Markup.button.callback('Cancel', `cancel_delete_wallet_${index}`)]
    ]);
    await ctx.replyWithMarkdown('⚠️ Are you sure you want to delete this wallet? This cannot be undone.', confirmKeyboard);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error initiating wallet deletion: ${error.message}`);
    await ctx.answerCbQuery();
  }
});

bot.action(/^confirm_delete_wallet_(\d+)$/, async (ctx) => {
  try {
    const index = parseInt(ctx.match[1], 10);
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    if (!userState.wallets[index]) {
      return ctx.replyWithMarkdown('⚠️ Wallet not found.');
    }
    userState.wallets.splice(index, 1);
    userState.walletAddresses.splice(index, 1);
    await updateUserState(userId, { wallets: userState.wallets, walletAddresses: userState.walletAddresses });
    await ctx.replyWithMarkdown('✅ Wallet deleted successfully.');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error deleting wallet: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Error deleting wallet. Please try again later.');
    await ctx.answerCbQuery();
  }
});

bot.action(/^cancel_delete_wallet_(\d+)$/, async (ctx) => {
  try {
    await ctx.replyWithMarkdown('Wallet deletion canceled.');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error cancelling wallet deletion: ${error.message}`);
    await ctx.answerCbQuery();
  }
});

// Callback: Edit Bank for Wallet (reuse bank linking scene)
bot.action(/^edit_bank_wallet_(\d+)$/, async (ctx) => {
  try {
    const index = parseInt(ctx.match[1], 10);
    ctx.session.walletIndex = index;
    await ctx.scene.enter('bank_linking_scene');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error initiating bank edit for wallet: ${error.message}`);
    await ctx.answerCbQuery();
  }
});

// -------------------- Rename Wallet Scene --------------------
const renameWalletScene = new Scenes.WizardScene(
  'rename_wallet_scene',
  async (ctx) => {
    try {
      const userState = await getUserState(ctx.from.id.toString());
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '📋 Enter a new name for your wallet:'
        : 'Please enter a new name for your wallet:');
      ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in rename_wallet_scene step 1: ${error.message}`);
      ctx.scene.leave();
    }
  },
  async (ctx) => {
    try {
      const newName = ctx.message.text.trim();
      if (!newName) {
        return ctx.replyWithMarkdown('❌ Name cannot be empty. Enter a valid name:');
      }
      const walletIndex = ctx.session.renameWalletIndex;
      const userId = ctx.from.id.toString();
      let userState = await getUserState(userId);
      if (userState.wallets[walletIndex]) {
        userState.wallets[walletIndex].label = newName;
        await updateUserState(userId, { wallets: userState.wallets });
        await ctx.replyWithMarkdown(`✅ Wallet renamed to *${newName}* successfully.`);
      } else {
        await ctx.replyWithMarkdown('⚠️ Wallet not found.');
      }
      delete ctx.session.renameWalletIndex;
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error in rename_wallet_scene step 2: ${error.message}`);
      ctx.scene.leave();
    }
  }
);

// -------------------- Send Message Scene (Admin) --------------------
const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  async (ctx) => {
    try {
      const userState = await getUserState(ctx.from.id.toString());
      const prompt = userState.usePidgin
        ? '📩 Enter the User ID you want to message:'
        : '📩 Please enter the User ID you wish to message:';
      await ctx.replyWithMarkdown(prompt);
      ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in send_message_scene step 1: ${error.message}`);
      ctx.scene.leave();
    }
  },
  async (ctx) => {
    try {
      const userIdToMessage = ctx.message.text.trim();
      const userState = await getUserState(ctx.from.id.toString());
      if (!/^\d{5,15}$/.test(userIdToMessage)) {
        const errorMsg = userState.usePidgin
          ? '❌ User ID no correct! Enter a valid number (5-15 digits):'
          : '❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }
      const userDoc = await db.collection('users').doc(userIdToMessage).get();
      if (!userDoc.exists) {
        const errorMsg = userState.usePidgin
          ? '❌ User ID not found. Check and try again.'
          : '❌ User ID not found. Please check and try again.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }
      ctx.session.userIdToMessage = userIdToMessage;
      const prompt = userState.usePidgin
        ? '📝 Enter the message to send (you can attach a photo too):'
        : '📝 Please enter the message (photo attachment optional):';
      await ctx.replyWithMarkdown(prompt);
      ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in send_message_scene step 2: ${error.message}`);
      ctx.scene.leave();
    }
  },
  async (ctx) => {
    try {
      const userIdToMessage = ctx.session.userIdToMessage;
      const adminUserId = ctx.from.id.toString();
      const userState = await getUserState(adminUserId);
      if (ctx.message.photo) {
        const photoArray = ctx.message.photo;
        const highestResolutionPhoto = photoArray[photoArray.length - 1];
        const fileId = highestResolutionPhoto.file_id;
        const caption = ctx.message.caption || '';
        try {
          await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption, parse_mode: 'Markdown' });
          const successMsg = userState.usePidgin ? '✅ Photo message sent!' : '✅ Photo message sent successfully.';
          await ctx.replyWithMarkdown(successMsg);
        } catch (error) {
          logger.error(`Error sending photo to ${userIdToMessage}: ${error.message}`);
          const errorMsg = userState.usePidgin
            ? '⚠️ E no work o! Check User ID or if bot blocked.'
            : '⚠️ Error sending photo. Please check the User ID.';
          await ctx.replyWithMarkdown(errorMsg);
        }
      } else if (ctx.message.text) {
        const messageContent = ctx.message.text.trim();
        if (!messageContent) {
          const errorMsg = userState.usePidgin
            ? '❌ Message cannot be empty. Enter something:'
            : '❌ Message cannot be empty.';
          await ctx.reply(errorMsg);
          return;
        }
        try {
          const adminMsg = userState.usePidgin
            ? `📩 *Message from Admin:*\n\n${messageContent}`
            : `📩 *Message from Admin:*\n\n${messageContent}`;
          await bot.telegram.sendMessage(userIdToMessage, adminMsg, { parse_mode: 'Markdown' });
          const successMsg = userState.usePidgin ? '✅ Text message sent!' : '✅ Message sent successfully.';
          await ctx.replyWithMarkdown(successMsg);
        } catch (error) {
          logger.error(`Error sending message to ${userIdToMessage}: ${error.message}`);
          const errorMsg = userState.usePidgin
            ? '⚠️ E no work o! Check User ID or if bot blocked.'
            : '⚠️ Error sending message. Please check the User ID.';
          await ctx.replyWithMarkdown(errorMsg);
        }
      } else {
        const errorMsg = userState.usePidgin
          ? '❌ Unsupported type! Send text or photo.'
          : '❌ Unsupported message type.';
        await ctx.reply(errorMsg);
      }
      delete ctx.session.userIdToMessage;
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error in send_message_scene step 3: ${error.message}`);
      ctx.scene.leave();
    }
  }
);

const stage = new Scenes.Stage();
stage.register(bankLinkingScene, renameWalletScene, sendMessageScene);

// =================== Apply Middlewares ===================
bot.use(session());
bot.use(stage.middleware());

// =================== Exchange Rate Fetching ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 0, USDT: 0 };

async function fetchExchangeRate(asset) {
  try {
    logger.debug(`Fetching exchange rate for ${asset}`);
    const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
      headers: {
        'Authorization': `Bearer ${PAYCREST_API_KEY}`,
        'Content-Type': 'application/json'
      },
    });
    if (response.data.status === 'success' && response.data.data) {
      const rate = parseFloat(response.data.data);
      if (isNaN(rate)) {
        throw new Error(`Invalid rate for ${asset}: ${response.data.data}`);
      }
      logger.debug(`Exchange rate for ${asset}: ${rate}`);
      return rate;
    } else {
      throw new Error(`Failed to fetch rate for ${asset}: ${response.data.message || 'Unknown error'}`);
    }
  } catch (error) {
    logger.error(`Error fetching rate for ${asset}: ${error.message}`);
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
    logger.error(`Error fetching exchange rates: ${error.message}`);
  }
}

fetchExchangeRates();
setInterval(fetchExchangeRates, 300000);

async function fetchCoinGeckoRates() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,tether&vs_currencies=ngn');
    return {
      USDC: response.data['usd-coin'].ngn,
      USDT: response.data.tether.ngn
    };
  } catch (error) {
    logger.error(`Error fetching CoinGecko rates: ${error.message}`);
    return { USDC: 0, USDT: 0 };
  }
}

// =================== View Current Rates Handler ===================
bot.hears('📈 View Current Rates', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const displayName = userState.firstName || 'sharp person';
    const coingeckoRates = await fetchCoinGeckoRates();
    const now = new Date().toLocaleTimeString('en-US', { timeZone: 'Africa/Lagos', hour12: false });
    const date = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
    let ratesMessage = userState.usePidgin
      ? `📈 *Current Exchange Rates (${now} WAT, ${date})*\n\n`
      : `📈 *Current Exchange Rates (${now} WAT, ${date})*\n\n`;
    for (const asset of SUPPORTED_ASSETS) {
      const paycrestRate = exchangeRates[asset];
      const coingeckoRate = coingeckoRates[asset];
      const diff = paycrestRate - coingeckoRate;
      let funnyComment = '';
      if (userState.usePidgin) {
        if (diff > 0) {
          const profit = diff * 100;
          funnyComment = `*Ehen, ${displayName}! Extra ₦${profit.toFixed(2)} for 100 ${asset}!*`;
        } else if (diff < 0) {
          const loss = Math.abs(diff) * 100;
          funnyComment = `*Chai, ${displayName}! Market dey beat us by ₦${loss.toFixed(2)} for 100 ${asset}!*`;
        } else {
          funnyComment = `*No wahala, ${displayName}! Rates dey match!*`;
        }
      } else {
        if (diff > 0) {
          const profit = diff * 100;
          funnyComment = `*Great news, ${displayName}! Extra ₦${profit.toFixed(2)} for 100 ${asset}.*`;
        } else if (diff < 0) {
          const loss = Math.abs(diff) * 100;
          funnyComment = `*Oh no, ${displayName}! Market is ahead by ₦${loss.toFixed(2)} for 100 ${asset}.*`;
        } else {
          funnyComment = `*Rates are neck-and-neck, ${displayName}!*`;
        }
      }
      ratesMessage += `• *${asset}*\n  - DirectPay Rate: ₦${paycrestRate.toFixed(2)}\n  - CoinGecko Rate: ₦${coingeckoRate.toFixed(2)}\n  - ${funnyComment}\n\n`;
    }
    ratesMessage += userState.usePidgin
      ? `No dulling, ${displayName}! DirectPay rates dey cho!`
      : `Stay smart, ${displayName}! DirectPay’s rates beat the market!`;
    const mainMenu = getMainMenu(userState);
    await ctx.replyWithMarkdown(ratesMessage, { reply_markup: mainMenu.reply_markup });
  } catch (error) {
    logger.error(`Error fetching rates: ${error.message}`);
    const userState = await getUserState(ctx.from.id.toString());
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later.'
      : '⚠️ Unable to fetch current rates. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== Admin Panel Handlers ===================
bot.action('open_admin_panel', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    if (!isAdmin(userId)) {
      const errorMsg = userState.usePidgin
        ? '⚠️ You no be admin o! Only big bosses allowed.'
        : '⚠️ You’re not an admin! Only authorized users can access this panel.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }
    ctx.session.adminMessageId = null;
    const menuText = userState.usePidgin
      ? `👨‍💼 **Admin Panel**\n\nSelect an option, ${userState.firstName || 'Oga'}:`
      : `👨‍💼 **Admin Panel**\n\nSelect an option, ${userState.firstName || 'esteemed user'}:`;
    const sentMessage = await ctx.reply(menuText, getAdminMenu());
    ctx.session.adminMessageId = sentMessage.message_id;
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error opening admin panel: ${error.message}`);
    await ctx.answerCbQuery();
  }
});

const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View Recent Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📨 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);

bot.action(/admin_(.+)/, async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    if (!isAdmin(userId)) {
      const errorMsg = userState.usePidgin
        ? '⚠️ You no fit enter here o! Admin only zone.'
        : '⚠️ You can’t access this! Admin-only zone.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }
    const action = ctx.match[1];
    switch (action) {
      case 'view_transactions': {
        try {
          const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();
          if (transactionsSnapshot.empty) {
            await ctx.answerCbQuery(userState.usePidgin ? 'No transactions dey o.' : 'No transactions found.', { show_alert: true });
            return;
          }
          let message = userState.usePidgin
            ? '📋 **Recent Transactions**:\n\n'
            : '📋 **Recent Transactions**:\n\n';
          transactionsSnapshot.forEach((doc) => {
            const tx = doc.data();
            message += `*User ID:* ${tx.userId || 'N/A'}\n*Reference:* \`${tx.referenceId || 'N/A'}\`\n*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n*Status:* ${tx.status || 'Pending'}\n*Chain:* ${tx.chain || 'N/A'}\n*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
          });
          const inlineKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback(userState.usePidgin ? '🔙 Back to Admin Menu' : '🔙 Back to Admin Menu', 'admin_back_to_main')]
          ]);
          await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
          await ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error fetching transactions: ${error.message}`);
          await ctx.answerCbQuery(userState.usePidgin ? '⚠️ No fit fetch transactions o.' : '⚠️ Unable to fetch transactions.', { show_alert: true });
        }
        break;
      }
      case 'send_message': {
        try {
          const usersSnapshot = await db.collection('users').get();
          if (usersSnapshot.empty) {
            const errorMsg = userState.usePidgin
              ? '⚠️ No users dey to send message o.'
              : '⚠️ No users found.';
            await ctx.replyWithMarkdown(errorMsg);
            return ctx.answerCbQuery();
          }
          await ctx.scene.enter('send_message_scene');
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error initiating send message: ${error.message}`);
          const errorMsg = userState.usePidgin
            ? '⚠️ E no work o! Try again later.'
            : '⚠️ Error initiating message. Please try again later.';
          await ctx.replyWithMarkdown(errorMsg);
          ctx.answerCbQuery();
        }
        break;
      }
      case 'mark_paid': {
        try {
          const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
          if (pendingTransactions.empty) {
            await ctx.answerCbQuery(userState.usePidgin ? 'No pending transactions dey o.' : 'No pending transactions found.', { show_alert: true });
            return;
          }
          const batch = db.batch();
          pendingTransactions.forEach((transaction) => {
            const docRef = db.collection('transactions').doc(transaction.id);
            batch.update(docRef, { status: 'Paid' });
          });
          await batch.commit();
          pendingTransactions.forEach(async (transaction) => {
            const txData = transaction.data();
            try {
              const payout = txData.payout || 'N/A';
              const accountName = txData.bankDetails && txData.bankDetails.accountName ? txData.bankDetails.accountName : 'Valued User';
              const userStateTx = await getUserState(txData.userId);
              const successMsg = userStateTx.usePidgin
                ? `🎉 *Transaction Successful!*\n\nHello ${accountName}, your order don complete!\n*Crypto:* ${txData.amount} ${txData.asset}\n*Cash:* NGN ${payout}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\nYou don hammer!`
                : `🎉 *Funds Credited Successfully!*\n\nHello ${accountName}, your order has been completed.\n*Crypto:* ${txData.amount} ${txData.asset}\n*Cash:* NGN ${payout}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\nYou've struck gold!`;
              await bot.telegram.sendPhoto(txData.userId, { source: PAYOUT_SUCCESS_IMAGE }, { caption: successMsg, parse_mode: 'Markdown' });
              logger.info(`Notified user ${txData.userId} about paid transaction ${txData.referenceId}`);
            } catch (error) {
              logger.error(`Error notifying user ${txData.userId}: ${error.message}`);
            }
          });
          const successMsg = userState.usePidgin
            ? '✅ All pending transactions don mark as paid o!'
            : '✅ All pending transactions have been marked as paid.';
          await ctx.editMessageText(successMsg, { reply_markup: getAdminMenu().reply_markup });
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error marking transactions as paid: ${error.message}`);
          await ctx.answerCbQuery(userState.usePidgin ? '⚠️ E no work o! Try again later.' : '⚠️ Error marking transactions as paid.', { show_alert: true });
        }
        break;
      }
      case 'view_users': {
        try {
          const usersSnapshot = await db.collection('users').get();
          if (usersSnapshot.empty) {
            await ctx.answerCbQuery(userState.usePidgin ? 'No users dey o.' : 'No users found.', { show_alert: true });
            return;
          }
          let message = userState.usePidgin
            ? '👥 **All Users**:\n\n'
            : '👥 **All Users**:\n\n';
          usersSnapshot.forEach((doc) => {
            const user = doc.data();
            message += `*User ID:* ${doc.id}\n*Name:* ${user.firstName || 'N/A'}\n*Wallets:* ${user.wallets.length}\n*Bank Linked:* ${user.wallets.some(wallet => wallet.bank) ? 'Yes' : 'No'}\n\n`;
          });
          const inlineKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback(userState.usePidgin ? '🔙 Back to Admin Menu' : '🔙 Back to Admin Menu', 'admin_back_to_main')]
          ]);
          await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error fetching users: ${error.message}`);
          await ctx.answerCbQuery(userState.usePidgin ? '⚠️ No fit fetch users o.' : '⚠️ Unable to fetch users.', { show_alert: true });
        }
        break;
      }
      case 'broadcast_message': {
        try {
          const usersSnapshot = await db.collection('users').get();
          if (usersSnapshot.empty) {
            const errorMsg = userState.usePidgin
              ? '⚠️ No users dey to broadcast o.'
              : '⚠️ No users available.';
            await ctx.replyWithMarkdown(errorMsg);
            return ctx.answerCbQuery();
          }
          const prompt = userState.usePidgin
            ? '📢 Enter the broadcast message (you can attach an image):'
            : '📢 Enter the broadcast message (image optional):';
          await ctx.reply(prompt);
          await ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error initiating broadcast: ${error.message}`);
          const errorMsg = userState.usePidgin
            ? '⚠️ E no work o! Try again later.'
            : '⚠️ Error initiating broadcast. Please try again later.';
          await ctx.replyWithMarkdown(errorMsg);
          ctx.answerCbQuery();
        }
        break;
      }
      case 'back_to_main': {
        try {
          await greetUser(ctx);
          if (ctx.session.adminMessageId) {
            await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
            ctx.session.adminMessageId = null;
          }
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error in admin back to main: ${error.message}`);
          ctx.answerCbQuery();
        }
        break;
      }
      default:
        await ctx.answerCbQuery(userState.usePidgin ? '⚠️ Unknown option, choose again.' : '⚠️ Unknown option.', { show_alert: true });
    }
  } catch (error) {
    logger.error(`Error processing admin action: ${error.message}`);
    await ctx.answerCbQuery();
  }
});

// =================== Paycrest Webhook Handler ===================
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-paycrest-signature'];
    const rawBody = req.body;
    if (!signature) {
      logger.error('No Paycrest signature found.');
      return res.status(400).send('Signature missing.');
    }
    if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
      logger.error('Invalid Paycrest signature.');
      return res.status(401).send('Invalid signature.');
    }
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody.toString());
    } catch (error) {
      logger.error(`Failed to parse Paycrest webhook body: ${error.message}`);
      return res.status(400).send('Invalid JSON.');
    }
    const event = parsedBody.event;
    const data = parsedBody.data;
    logger.info(`Received Paycrest event: ${event}`);
    const orderId = data.id;
    const amountPaid = parseFloat(data.amountPaid) || 0;
    const reference = data.reference;
    const returnAddress = data.returnAddress;
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();
    if (txSnapshot.empty) {
      logger.error(`No transaction found for orderId: ${orderId}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ No transaction found for orderId: \`${orderId}\``, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userState = await getUserState(userId);
    const userFirstName = userState.firstName || 'valued user';
    switch (event) {
      case 'payment_order.pending': {
        const pendingMsg = userState.usePidgin
          ? 'We dey process your order. Abeg wait small.'
          : 'Your order is being processed. Please wait.';
        await bot.telegram.sendMessage(userId, pendingMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Payment Order Pending*\n*User:* ${userFirstName} (ID: ${userId})\n*Reference:* ${reference}\n*Amount Paid:* ₦${amountPaid}\n`, { parse_mode: 'Markdown' });
        break;
      }
      case 'payment_order.settled': {
        const accountName = txData.bankDetails ? txData.bankDetails.accountName : 'User';
        const payout = txData.payout || 'N/A';
        const payoutMessage = userState.usePidgin
          ? `🎉 *Funds Credited Successfully!*\n\nHello ${accountName}, your order has been completed.\n*Crypto:* ${txData.amount} ${txData.asset}\n*Cash:* NGN ${payout}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\nYou've struck gold!`
          : `🎉 *Funds Credited Successfully!*\n\nHello ${accountName}, your order has been completed.\n*Crypto:* ${txData.amount} ${txData.asset}\n*Cash:* NGN ${payout}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\nYou've struck gold!`;
        await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, { caption: payoutMessage, parse_mode: 'Markdown' });
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Completed' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Order Settled*\n*User:* ${userFirstName} (ID: ${userId})\n*Reference:* ${reference}\n*Amount Paid:* ₦${amountPaid}\n`, { parse_mode: 'Markdown' });
        if (!userState.hasReceivedDeposit) {
          const feedbackMsg = userState.usePidgin
            ? `📝 *Feedback*\nHow you see DirectPay so far, ${userFirstName}?\n[👍 Great o!] [👎 No good] [🤔 Suggestions]`
            : `📝 *Feedback*\nHow was your experience, ${userFirstName}?\n[👍 Great!] [👎 Not Good] [🤔 Suggestions]`;
          await bot.telegram.sendMessage(userId, feedbackMsg, Markup.inlineKeyboard([
            [Markup.button.callback(userState.usePidgin ? '👍 Great o!' : '👍 Great!', 'feedback_great')],
            [Markup.button.callback(userState.usePidgin ? '👎 No good' : '👎 Not Good', 'feedback_not_good')],
            [Markup.button.callback('🤔 Suggestions', 'feedback_suggestions')]
          ]));
          await updateUserState(userId, { hasReceivedDeposit: true });
        }
        break;
      }
      case 'payment_order.expired': {
        const expiredMsg = userState.usePidgin
          ? `⚠️ *Order Expired!*\nHello ${userFirstName}, your order with Ref: \`${reference}\` has expired. Funds returned.`
          : `⚠️ *Order Expired!*\nHello ${userFirstName}, your order with Ref: \`${reference}\` has expired. Funds returned.`;
        await bot.telegram.sendMessage(userId, expiredMsg, { parse_mode: 'Markdown' });
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Expired' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⏰ *Order Expired*\n*User:* ${userFirstName} (ID: ${userId})\n*Reference:* ${reference}\n`, { parse_mode: 'Markdown' });
        break;
      }
      case 'payment_order.refunded': {
        const refundedMsg = userState.usePidgin
          ? `❌ *Your DirectPay order has been refunded!*\n\nHello ${userFirstName}, your order with Ref: \`${reference}\` has been refunded.`
          : `❌ *Your DirectPay order has been refunded.*\n\nHello ${userFirstName}, your order with Ref: \`${reference}\` has been refunded.`;
        await bot.telegram.sendMessage(userId, refundedMsg, { parse_mode: 'Markdown' });
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Refunded' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Order Refunded*\n*User:* ${userFirstName} (ID: ${userId})\n*Reference:* ${reference}\n*Amount Paid:* ₦${amountPaid}\n`, { parse_mode: 'Markdown' });
        break;
      }
      default:
        logger.info(`Unhandled event type: ${event}`);
    }
    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook: ${error.message}`);
    await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: ERROR_IMAGE }, { caption: `❗️ Error: ${error.message}`, parse_mode: 'Markdown' });
    res.status(500).send('Error processing webhook');
  }
});

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

app.post(WEBHOOK_BLOCKRADAR_PATH, bodyParser.json(), async (req, res) => {
  try {
    const event = req.body;
    if (!event) {
      logger.error('No event data in Blockradar webhook.');
      return res.status(400).send('No event data.');
    }
    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);
    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';
    const senderAddress = event.data?.senderAddress || 'N/A';
    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain: ${chainRaw}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Unknown chain: \`${chainRaw}\``);
      return res.status(400).send('Unknown chain.');
    }
    const chain = chainKey;
    if (eventType === 'deposit.success') {
      if (walletAddress === 'N/A') {
        logger.error('Missing wallet address in webhook.');
        return res.status(400).send('Missing wallet address.');
      }
      const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
      if (!existingTxSnapshot.empty) {
        logger.info(`Transaction ${transactionHash} exists. Skipping.`);
        return res.status(200).send('OK');
      }
      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user for wallet ${walletAddress}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user for wallet: \`${walletAddress}\``);
        return res.status(200).send('OK');
      }
      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find((w) => w.address === walletAddress);
      if (!wallet || !wallet.bank) {
        const noBankMsg = userState.usePidgin
          ? `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}. Abeg link bank account, so we go fit pay you!`
          : `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}. Please link your bank account.`;
        await bot.telegram.sendMessage(userId, noBankMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposit but no bank linked.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      if (!['USDC', 'USDT'].includes(asset)) {
        const unsupportedMsg = userState.usePidgin
          ? `⚠️ *Unsupported Asset:* ${amount} ${asset} on ${chainRaw}. Na only USDC/USDT dey work!`
          : `⚠️ *Unsupported Asset:* ${amount} ${asset} on ${chainRaw}. Only USDC/USDT are supported.`;
        await bot.telegram.sendMessage(userId, unsupportedMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Unsupported asset ${asset} for user ${userId}.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      const blockradarRate = event.data?.rate || 0;
      const serviceFeePercent = 0.5;
      const ngnAmount = calculatePayoutWithFee(amount, blockradarRate, serviceFeePercent);
      const referenceId = generateReferenceId();
      const { bankName, accountNumber, accountName } = wallet.bank;
      const userFirstName = userState.firstName || 'valued user';
      const transactionRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chainRaw,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: { bankName, accountNumber, accountName },
        payout: ngnAmount,
        rate: blockradarRate,
        timestamp: new Date().toISOString(),
        status: 'Pending',
        paycrestOrderId: '',
        messageId: null,
        firstName: userFirstName
      });
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚡️ *New Deposit*\n*User ID:* ${userId}\n*Username:* @${req.body?.from?.username || 'N/A'}\n*Name:* ${userFirstName}\n*Amount:* ${amount} ${asset}\n*Rate:* ₦${blockradarRate} per ${asset}\n*Payout:* ₦${ngnAmount.toFixed(2)}\n*Time:* ${new Date().toLocaleString()}\n*Bank:* ${bankName}\n*Tx Hash:* \`${transactionHash}\`\n*Reference:* ${referenceId}\n`, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    } else {
      logger.info(`Unhandled event type: ${event}`);
      return res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: ERROR_IMAGE }, { caption: `❗️ Error: ${error.message}`, parse_mode: 'Markdown' });
    res.status(500).send('Error processing webhook');
  }
});

app.use(WEBHOOK_PATH, bodyParser.json());
app.post(WEBHOOK_PATH, bodyParser.json(), async (req, res) => {
  try {
    if (!req.body) {
      logger.error('No body in Telegram webhook.');
      return res.status(400).send('No body found.');
    }
    const clientIp = requestIp.getClientIp(req);
    let location = 'Unknown';
    try {
      const geoResponse = await axios.get(`http://ip-api.com/json/${clientIp}`);
      if (geoResponse.data.status === 'success') {
        location = geoResponse.data.country;
      }
    } catch (error) {
      logger.error(`Error fetching geolocation for IP ${clientIp}: ${error.message}`);
    }
    req.session = req.session || {};
    req.session.location = location;
    logger.info(`Received Telegram update from ${location}: ${JSON.stringify(req.body, null, 2)}`);
    bot.handleUpdate(req.body, res);
  } catch (error) {
    logger.error(`Error handling Telegram webhook: ${error.message}`);
    res.status(500).send('Error handling update');
  }
});

const SERVER_PORT = PORT;
app.listen(SERVER_PORT, () => {
  logger.info(`Webhook server running on port ${SERVER_PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
