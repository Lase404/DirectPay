// =================== Import Dependencies ===================
const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const sharp = require('sharp');
require('dotenv').config();

// =================== Logger Setup ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`
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
  COINGECKO_API_KEY,
} = process.env;

if (!BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY || !COINGECKO_API_KEY) {
  logger.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

// =================== Image File IDs ===================
const depositSuccessImage = 'AAMCBAADGQEAAhwYZ7fssuzPC9COzm0tqo-ocaZM_6UAArgcAAJnC8FRNbki6XorEmEBAAdtAAM2BA';
const paymentSettledImage = 'AAMCBAADGQEAAhwXZ7fsrCk1AdBYBcRu3vkoLAU5QLcAArccAAJnC8FRVIqfw9CeOBEBAAdtAAM2BA';
const walletGeneratedBaseImage = 'AgACAgQAAxkBAAIcHGe91Ora-irbqhuTTWEKlPvwCEVYAALDxzEbsujxUby5bO7b177hAQADAgADcwADNgQ';
const errorImage = 'YOUR_ERROR_FILE_ID';

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
    assets: { USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3', USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3' }
  },
  Polygon: {
    id: 'f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a',
    key: BLOCKRADAR_POLYGON_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon',
    assets: { USDC: 'f348e8e3-e0b4-4704-857e-c274ef000c00', USDT: 'c9d57a33-375b-46f7-b694-16e9b498e0e1' }
  },
  'BNB Smart Chain': {
    id: '7a844e91-5740-4589-9695-c74411adec7e',
    key: BLOCKRADAR_BNB_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain',
    assets: { USDC: 'ff479231-0dbb-4760-b695-e219a50934af', USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb' }
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
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    logger.error(`Error verifying bank account (${accountNumber}, ${bankCode}): ${error.response ? error.response.data.message : error.message}`);
    throw new Error('Failed to verify bank account. Please check your details or try again later.');
  }
}

async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
    const paycrestMapping = mapToPaycrest(token, network);
    if (!paycrestMapping) throw new Error('Unsupported asset or chain for Paycrest.');
    const bank = bankList.find(b => b.name.toLowerCase() === recipientDetails.bankName.toLowerCase());
    if (!bank || !bank.paycrestInstitutionCode) {
      const errorMsg = `No Paycrest institution code found for bank: ${recipientDetails.bankName}`;
      logger.error(errorMsg);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ ${errorMsg} for user ${userId}.`, { parse_mode: 'Markdown' });
      throw new Error(errorMsg);
    }
    const recipient = {
      institution: bank.paycrestInstitutionCode,
      accountIdentifier: recipientDetails.accountNumber,
      accountName: recipientDetails.accountName,
      memo: `Payment from DirectPay`,
      providerId: ""
    };
    const rate = exchangeRates[token] || 0;
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
      headers: { 'API-Key': PAYCREST_API_KEY, 'Content-Type': 'application/json' }
    });
    if (orderResp.data.status !== 'success') throw new Error(`Paycrest order creation failed: ${orderResp.data.message || 'Unknown error'}`);
    return orderResp.data.data;
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.response ? err.response.data.message : err.message}`);
    throw new Error('Failed to create Paycrest order. Please contact support.');
  }
}

async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    const chainKey = chainMapping[chain.toLowerCase()];
    if (!chainKey) throw new Error(`Unsupported chain: ${chain}`);
    const chainData = chains[chainKey];
    if (!chainData) throw new Error(`Chain data not found for: ${chainKey}`);
    const resp = await axios.post(`https://api.blockradar.co/v1/wallets/${chainData.id}/withdraw`, {
      address,
      amount: String(amount),
      assetId,
      reference,
      metadata
    }, { headers: { 'x-api-key': chainData.key, 'Content-Type': 'application/json' } });
    if (resp.data.statusCode !== 200) throw new Error(`Blockradar withdrawal error: ${JSON.stringify(resp.data)}`);
    return resp.data;
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
        alertsEnabled: false,
      });
      return {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        alertsEnabled: false,
      };
    }
    const data = userDoc.data();
    return {
      firstName: data.firstName || '',
      wallets: data.wallets || [],
      walletAddresses: data.walletAddresses || [],
      hasReceivedDeposit: data.hasReceivedDeposit || false,
      awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
      alertsEnabled: data.alertsEnabled || false,
    };
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
    logger.error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
    throw new Error(`Error generating wallet for ${chain}: ${error.message}`);
  }
}

async function generateWalletGeneratedImage(walletAddress, fileId) {
  try {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const baseImageBuffer = Buffer.from(response.data);
    const qrCodeBuffer = await QRCode.toBuffer(walletAddress, { width: 85, margin: 1 });
    const outputBuffer = await sharp(baseImageBuffer).composite([{ input: qrCodeBuffer, top: 21, left: 21 }]).png().toBuffer();
    const uploadResponse = await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: outputBuffer });
    return uploadResponse.photo[uploadResponse.photo.length - 1].file_id;
  } catch (error) {
    logger.error(`Error generating wallet image with QR code: ${error.message}`);
    throw error;
  }
}

// =================== Constant Main Menu ===================
const getMainMenu = () => Markup.keyboard([
  ['💼 View Wallet'],
  ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
  ['📈 View Current Rates', '📝 Feedback']
]).resize();

// =================== Define Scenes ===================
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.session.walletIndex;
    if (walletIndex === undefined || walletIndex === null) {
      await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.', getMainMenu());
      return ctx.scene.leave();
    }
    ctx.session.bankData = { step: 1 };
    await ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered bank name: ${input}`);
    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));
    if (!bank) {
      await ctx.replyWithMarkdown('❌ Invalid bank name. Please enter a valid bank name from our supported list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n'));
      return;
    }
    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;
    await ctx.replyWithMarkdown('🔢 Please enter your 10-digit bank account number:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered account number: ${input}`);
    if (!/^\d{10}$/.test(input)) {
      await ctx.replyWithMarkdown('❌ Invalid account number. Please enter a valid 10-digit account number:');
      return;
    }
    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;
    const pendingMessage = await ctx.replyWithMarkdown('🔄 Verifying your bank details...');
    try {
      const verificationResult = await verifyBankAccount(ctx.session.bankData.accountNumber, ctx.session.bankData.bankCode);
      if (!verificationResult || !verificationResult.data) throw new Error('Invalid verification response.');
      const accountName = verificationResult.data.account_name;
      if (!accountName) throw new Error('Unable to retrieve account name.');
      ctx.session.bankData.accountName = accountName;
      ctx.session.bankData.step = 4;
      await bot.telegram.editMessageText(
        pendingMessage.chat.id,
        pendingMessage.message_id,
        null,
        `🏦 *Bank Account Verification*\n\n` +
        `Please confirm your bank details:\n` +
        `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
        `- *Account Number:* ${ctx.session.bankData.accountNumber}\n` +
        `- *Account Holder:* ${accountName}\n\n` +
        `Is this correct?`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
            [Markup.button.callback('❌ No, Edit', 'confirm_bank_no')],
            [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')],
          ]).reply_markup
        }
      );
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      await bot.telegram.editMessageText(
        pendingMessage.chat.id,
        pendingMessage.message_id,
        null,
        '❌ Failed to verify your bank account. Please check your details or try again later.',
        { parse_mode: 'Markdown' }
      );
      await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Verification failed.', reply_markup: getMainMenu().reply_markup });
      return ctx.scene.leave();
    }
  },
  async (ctx) => { /* Handled by actions */ }
);

bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;
  const pendingMessageId = ctx.update.callback_query.message.message_id;
  try {
    let userState = await getUserState(userId);
    const wallet = userState.wallets[walletIndex];
    if (!wallet) {
      await bot.telegram.editMessageText(ctx.chat.id, pendingMessageId, null, '⚠️ No wallet selected for linking. Please generate a wallet first.', { parse_mode: 'Markdown' });
      await bot.telegram.sendPhoto(userId, errorImage, { caption: 'No wallet found.', reply_markup: getMainMenu().reply_markup });
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }
    wallet.bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };
    await updateUserState(userId, { wallets: userState.wallets });
    const walletImageFileId = await generateWalletGeneratedImage(wallet.address, walletGeneratedBaseImage);
    await bot.telegram.editMessageText(
      ctx.chat.id,
      pendingMessageId,
      null,
      `👏 *Bank Account Linked Successfully!*\n\n` +
      `Welcome to DirectPay! Here’s your wallet setup:\n\n` +
      `*Wallet Address:* \`${wallet.address}\`\n` +
      `*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n` +
      `*Supported Assets:* USDC, USDT\n\n` +
      `*Bank Name:* ${bankData.bankName}\n` +
      `*Account Number:* ${bankData.accountNumber}\n` +
      `*Account Holder:* ${bankData.accountName}\n\n` +
      `Only USDC and USDT are supported across these networks. Contact support for other tokens.`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('📋 Copy Address', `copy_address_${wallet.address}`)]).reply_markup
      }
    );
    await bot.telegram.sendPhoto(userId, walletImageFileId, { caption: '', reply_markup: getMainMenu().reply_markup });
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n` +
      `*Account Name:* ${wallet.bank.accountName}\n` +
      `*Bank Name:* ${wallet.bank.bankName}\n` +
      `*Account Number:* ****${wallet.bank.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(wallet.bank)}`);
    await ctx.answerCbQuery('Bank linked successfully!');
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(ctx.chat.id, pendingMessageId, null, '❌ An error occurred while linking your bank. Please try again later.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Bank linking failed.', reply_markup: getMainMenu().reply_markup });
    await ctx.answerCbQuery('Error occurred.');
    ctx.scene.leave();
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  await bot.telegram.editMessageText(ctx.chat.id, ctx.update.callback_query.message.message_id, null, '⚠️ Let’s try again.', {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏦 Retry Bank Linking', 'retry_bank_linking')]]).reply_markup
  });
  await ctx.answerCbQuery();
  ctx.scene.reenter();
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  await bot.telegram.editMessageText(ctx.chat.id, ctx.update.callback_query.message.message_id, null, '❌ Bank linking canceled. You must link a bank account to proceed.', { parse_mode: 'Markdown' });
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.processType;
  await ctx.answerCbQuery();
  ctx.scene.leave();
});

bankLinkingScene.action('retry_bank_linking', async (ctx) => {
  await bot.telegram.editMessageText(ctx.chat.id, ctx.update.callback_query.message.message_id, null, '🏦 Please enter your bank name (e.g., Access Bank):', { parse_mode: 'Markdown' });
  ctx.scene.reenter();
  await ctx.answerCbQuery();
});

const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  async (ctx) => {
    await ctx.replyWithMarkdown('📩 Enter the User ID you want to message:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userIdToMessage = ctx.message.text.trim();
    if (!/^\d{5,15}$/.test(userIdToMessage)) {
      await ctx.replyWithMarkdown('❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):');
      return;
    }
    const userDoc = await db.collection('users').doc(userIdToMessage).get();
    if (!userDoc.exists) {
      await ctx.replyWithMarkdown('❌ User ID not found. Try another or check the ID:');
      return;
    }
    ctx.session.userIdToMessage = userIdToMessage;
    await ctx.replyWithMarkdown('📝 Enter the message to send, or attach an image (e.g., receipt):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userIdToMessage = ctx.session.userIdToMessage;
    const adminUserId = ctx.from.id.toString();
    const pendingMessage = await ctx.replyWithMarkdown('🔄 Sending message...');
    try {
      if (ctx.message.photo) {
        const photoArray = ctx.message.photo;
        const fileId = photoArray[photoArray.length - 1].file_id;
        const caption = ctx.message.caption || '';
        await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: caption, parse_mode: 'Markdown' });
        await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '✅ Photo message sent successfully.', { parse_mode: 'Markdown' });
        logger.info(`Admin ${adminUserId} sent photo to user ${userIdToMessage}. Caption: ${caption}`);
      } else if (ctx.message.text) {
        const messageContent = ctx.message.text.trim();
        if (!messageContent) {
          await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Message cannot be empty. Please enter valid text:', { parse_mode: 'Markdown' });
          return;
        }
        await bot.telegram.sendMessage(userIdToMessage, `📩 *Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
        await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '✅ Text message sent successfully.', { parse_mode: 'Markdown' });
        logger.info(`Admin ${adminUserId} sent text to user ${userIdToMessage}: ${messageContent}`);
      } else {
        await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Unsupported message type. Send text or a photo.', { parse_mode: 'Markdown' });
      }
      await ctx.replyWithMarkdown('Admin menu:', getAdminMenu());
    } catch (error) {
      logger.error(`Error sending message to ${userIdToMessage}: ${error.message}`);
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '⚠️ Error sending message. Verify the User ID and try again.', { parse_mode: 'Markdown' });
      await bot.telegram.sendPhoto(adminUserId, errorImage, { caption: 'Message sending failed.', reply_markup: getAdminMenu().reply_markup });
    }
    delete ctx.session.userIdToMessage;
    ctx.scene.leave();
  }
);

const broadcastScene = new Scenes.WizardScene(
  'broadcast_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId)) {
      await ctx.replyWithMarkdown('⚠️ Unauthorized access.', getMainMenu());
      return ctx.scene.leave();
    }
    await ctx.replyWithMarkdown('📢 Enter the broadcast message, or attach an image:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const adminUserId = ctx.from.id.toString();
    const pendingMessage = await ctx.replyWithMarkdown('🔄 Broadcasting...');
    try {
      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) throw new Error('No users to broadcast to.');
      if (ctx.message.photo) {
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const caption = ctx.message.caption || '';
        for (const doc of usersSnapshot.docs) {
          await bot.telegram.sendPhoto(doc.id, fileId, { caption, parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup });
        }
      } else if (ctx.message.text) {
        const messageContent = ctx.message.text.trim();
        if (!messageContent) throw new Error('Message cannot be empty.');
        for (const doc of usersSnapshot.docs) {
          await bot.telegram.sendMessage(doc.id, `📢 *Broadcast from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup });
        }
      } else {
        throw new Error('Unsupported message type.');
      }
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '✅ Broadcast sent successfully.', { parse_mode: 'Markdown' });
      await ctx.replyWithMarkdown('Admin menu:', getAdminMenu());
    } catch (error) {
      logger.error(`Error broadcasting for ${adminUserId}: ${error.message}`);
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Failed to send broadcast. Try again.', { parse_mode: 'Markdown' });
      await bot.telegram.sendPhoto(adminUserId, errorImage, { caption: 'Broadcast failed.', reply_markup: getAdminMenu().reply_markup });
    }
    ctx.scene.leave();
  }
);

const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene, broadcastScene);

// =================== Apply Middlewares ===================
bot.use(session());
bot.use(stage.middleware());

// =================== Exchange Rate Fetching ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 0, USDT: 0 };

async function fetchExchangeRate(asset) {
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
      headers: { 'Authorization': `Bearer ${PAYCREST_API_KEY}`, 'Content-Type': 'application/json' },
    });
    if (response.data.status === 'success' && response.data.data) {
      const rate = parseFloat(response.data.data);
      if (isNaN(rate)) throw new Error(`Invalid rate data for ${asset} from Paycrest`);
      return rate;
    }
    throw new Error(`Failed to fetch rate for ${asset} from Paycrest: ${response.data.message || 'Unknown error'}`);
  } catch (error) {
    logger.error(`Error fetching Paycrest rate for ${asset}: ${error.message}`);
    return 0;
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

async function fetchCoinGeckoRate(asset) {
  try {
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${asset.toLowerCase()}&vs_currencies=ngn&x_cg_demo_api_key=${COINGECKO_API_KEY}`);
    const rate = response.data[asset.toLowerCase()]?.ngn || 0;
    if (isNaN(rate)) throw new Error(`Invalid rate data for ${asset} from CoinGecko`);
    return rate;
  } catch (error) {
    logger.error(`Error fetching CoinGecko rate for ${asset}: ${error.message}`);
    return 0;
  }
}

fetchExchangeRates();
setInterval(fetchExchangeRates, 300000);

// =================== Check if User is Admin ===================
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

// =================== /start Command ===================
bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    let userState = await getUserState(userId);
    if (!userState.firstName) {
      await updateUserState(userId, { firstName: ctx.from.first_name || 'Valued User' });
      userState.firstName = ctx.from.first_name || 'Valued User';
    }
    const greeting = userState.wallets.length > 0
      ? `👋 Hello, ${userState.firstName}!\n\nWelcome back to **DirectPay**.`
      : `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Generate a wallet to get started!`;
    await ctx.replyWithMarkdown(greeting, getMainMenu());
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await bot.telegram.sendPhoto(ctx.from.id, errorImage, { caption: '⚠️ An error occurred. Please try again later.', reply_markup: getMainMenu().reply_markup });
  }
});

// =================== Generate Wallet Handler ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let pendingMessage;
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You’ve reached the maximum of ${MAX_WALLETS} wallets. Manage existing wallets before adding new ones.`, getMainMenu());
      return;
    }
    pendingMessage = await ctx.replyWithMarkdown('🔄 Generating wallet... Please wait.');
    const chain = 'Base';
    const walletAddress = await generateWallet(chain);
    userState.wallets.push({
      address: walletAddress,
      chain: chain,
      supportedAssets: ['USDC', 'USDT'],
      bank: null,
      amount: 0
    });
    userState.walletAddresses.push(walletAddress);
    await updateUserState(userId, { wallets: userState.wallets, walletAddresses: userState.walletAddresses });
    await bot.telegram.editMessageText(
      pendingMessage.chat.id,
      pendingMessage.message_id,
      null,
      `✅ *Wallet Generated Successfully!*\n\n` +
      `*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n` +
      `*Supported Assets:* USDC, USDT\n\n` +
      `Please link a bank account to proceed.`,
      { parse_mode: 'Markdown' }
    );
    ctx.session.walletIndex = userState.wallets.length - 1;
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet for ${userId}: ${error.message}`);
    if (pendingMessage) {
      await bot.telegram.editMessageText(
        pendingMessage.chat.id,
        pendingMessage.message_id,
        null,
        '❌ Wallet generation failed. Please try again later.',
        { parse_mode: 'Markdown' }
      );
      await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Wallet generation failed.', reply_markup: getMainMenu().reply_markup });
    } else {
      await bot.telegram.sendPhoto(userId, errorImage, { caption: '❌ Wallet generation failed. Please try again later.', reply_markup: getMainMenu().reply_markup });
    }
  }
});

// =================== Copy Address Handler ===================
bot.action(/copy_address_(.+)/, async (ctx) => {
  const walletAddress = ctx.match[1];
  await ctx.answerCbQuery(`Wallet address copied: ${walletAddress}`, { show_alert: true });
});

// =================== View Wallet Handler ===================
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Fetching wallets...');
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ No wallets exist. Generate one using "💼 Generate Wallet".', { parse_mode: 'Markdown' });
      await ctx.replyWithMarkdown('Menu:', getMainMenu());
      return;
    }
    let message = `💼 *Your Wallets*:\n\n`;
    userState.wallets.forEach((wallet, index) => {
      message += `*Wallet ${index + 1}:*\n` +
        `• *Chain:* ${wallet.chain}\n` +
        `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, message, { parse_mode: 'Markdown' });
    await ctx.replyWithMarkdown('Menu:', getMainMenu());
  } catch (error) {
    logger.error(`Error viewing wallets for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '⚠️ Failed to fetch wallets.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Wallet fetch failed.', reply_markup: getMainMenu().reply_markup });
  }
});

// =================== Settings Handler ===================
bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Loading settings...');
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ No wallets exist. Generate one first.', { parse_mode: 'Markdown' });
      await ctx.replyWithMarkdown('Menu:', getMainMenu());
      return;
    }
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '⚙️ *Settings Menu*', {
      parse_mode: 'Markdown',
      reply_markup: getSettingsMenu().reply_markup
    });
  } catch (error) {
    logger.error(`Error accessing settings for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '⚠️ Settings access failed.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Settings failed.', reply_markup: getMainMenu().reply_markup });
  }
});

const getSettingsMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
  [Markup.button.callback('✏️ Edit Linked Bank', 'settings_edit_bank')],
  [Markup.button.callback('🔔 Toggle Alerts', 'toggle_alerts')],
  [Markup.button.callback('💬 Support', 'settings_support')],
  [Markup.button.callback('🔙 Back', 'settings_back_main')],
]);

bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Processing...');
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length >= MAX_WALLETS) {
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, `⚠️ You’ve hit the ${MAX_WALLETS}-wallet limit. Manage existing wallets first.`, { parse_mode: 'Markdown' });
      await ctx.replyWithMarkdown('Settings:', getSettingsMenu());
      return ctx.answerCbQuery();
    }
    await bot.hears('💼 Generate Wallet')(ctx);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error generating wallet in settings for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Wallet generation failed. Please try again.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Wallet generation failed.', reply_markup: getSettingsMenu().reply_markup });
    await ctx.answerCbQuery();
  }
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Loading bank edit options...');
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ No wallets exist. Generate one first.', { parse_mode: 'Markdown' });
      await ctx.replyWithMarkdown('Settings:', getSettingsMenu());
      return ctx.answerCbQuery();
    }
    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '🔄 Entering bank linking...', { parse_mode: 'Markdown' });
      await ctx.scene.enter('bank_linking_scene');
    } else {
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_edit_bank_${index}`)
      ]);
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, 'Select the wallet to edit bank details:', {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(keyboard).reply_markup
      });
    }
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error editing bank in settings for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '⚠️ Failed to edit bank details. Please try again.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Bank edit failed.', reply_markup: getSettingsMenu().reply_markup });
    await ctx.answerCbQuery();
  }
});

bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Preparing to edit bank...');
  try {
    if (isNaN(walletIndex)) {
      await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '⚠️ Invalid wallet selection. Please try again.', { parse_mode: 'Markdown' });
      await ctx.replyWithMarkdown('Settings:', getSettingsMenu());
      return ctx.answerCbQuery();
    }
    ctx.session.walletIndex = walletIndex;
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '🔄 Entering bank linking...', { parse_mode: 'Markdown' });
    await ctx.scene.enter('bank_linking_scene');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error selecting wallet for bank edit for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Failed to proceed. Try again.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Bank edit failed.', reply_markup: getSettingsMenu().reply_markup });
    await ctx.answerCbQuery();
  }
});

bot.action('toggle_alerts', async (ctx) => {
  const userId = ctx.from.id.toString();
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Toggling alerts...');
  try {
    const userState = await getUserState(userId);
    const currentAlertSetting = userState.alertsEnabled || false;
    await updateUserState(userId, { alertsEnabled: !currentAlertSetting });
    await bot.telegram.editMessageText(
      pendingMessage.chat.id,
      pendingMessage.message_id,
      null,
      `🔔 Transaction alerts are now *${!currentAlertSetting ? 'enabled' : 'disabled'}*. You’ll ${!currentAlertSetting ? 'receive' : 'no longer receive'} completion notifications.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.replyWithMarkdown('Settings:', getSettingsMenu());
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error toggling alerts for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Failed to update alerts. Please try again.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Alert toggle failed.', reply_markup: getSettingsMenu().reply_markup });
    await ctx.answerCbQuery();
  }
});

bot.action('settings_support', async (ctx) => {
  await bot.telegram.editMessageText(ctx.chat.id, ctx.update.callback_query.message.message_id, null, '🛠️ *Support Section*\n\nSelect an option:', {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Issue', 'support_not_received')],
      [Markup.button.callback('💬 Contact Support', 'support_contact')],
    ]).reply_markup
  });
  await ctx.answerCbQuery();
});

bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Returning to main menu...');
  try {
    const userState = await getUserState(userId);
    const greeting = userState.wallets.length > 0
      ? `👋 Hello, ${userState.firstName}!\n\nWelcome back to **DirectPay**.`
      : `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Generate a wallet to get started!`;
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, greeting, { parse_mode: 'Markdown' });
    await ctx.replyWithMarkdown('Menu:', getMainMenu());
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error returning to main menu for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Failed to return to menu. Please try again.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Return to menu failed.', reply_markup: getMainMenu().reply_markup });
    await ctx.answerCbQuery();
  }
});

// =================== Support Handlers ===================
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nChoose an option:', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Issue', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

const detailedTutorials = {
  how_it_works: `
**📘 How DirectPay Works**

1. **Generate Your Wallet:**  
   - Use "💼 Generate Wallet" to create a wallet on Base, supporting USDC/USDT on Base, BNB Smart Chain, and Polygon.  

2. **Link Your Bank Account:**  
   - Provide bank details to receive payouts securely in NGN.  

3. **Receive Payments:**  
   - Share your wallet address for crypto deposits, which DirectPay converts to NGN at competitive rates.  

4. **Monitor Transactions:**  
   - Check "💰 Transactions" for all activity updates.  

5. **Support:**  
   - Access tutorials via "ℹ️ Support" or contact us at [@maxcswap](https://t.me/maxcswap).  

🔒 Your funds are secure with DirectPay’s encryption and protocols.
`,
  transaction_guide: `
**💰 Transaction Not Received?**

1. **Verify Address:**  
   - Ensure the sender used your correct DirectPay wallet address.  

2. **Check Bank Linking:**  
   - Confirm your bank is linked via "⚙️ Settings" > "✏️ Edit Linked Bank".  

3. **Monitor Status:**  
   - View "💰 Transactions" to check deposit progress.  

4. **Wait Briefly:**  
   - Deposits may take minutes due to network delays.  

5. **Contact Support:**  
   - Reach out at [@maxcswap](https://t.me/maxcswap) if issues persist.
`,
};

bot.action('support_how_it_works', async (ctx) => {
  await bot.telegram.editMessageText(ctx.chat.id, ctx.update.callback_query.message.message_id, null, detailedTutorials.how_it_works, { parse_mode: 'Markdown' });
  await ctx.replyWithMarkdown('Menu:', getMainMenu());
  await ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  await bot.telegram.editMessageText(ctx.chat.id, ctx.update.callback_query.message.message_id, null, detailedTutorials.transaction_guide, { parse_mode: 'Markdown' });
  await ctx.replyWithMarkdown('Menu:', getMainMenu());
  await ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  await bot.telegram.editMessageText(ctx.chat.id, ctx.update.callback_query.message.message_id, null, 'Contact our support team at [@maxcswap](https://t.me/maxcswap).', { parse_mode: 'Markdown' });
  await ctx.replyWithMarkdown('Menu:', getMainMenu());
  await ctx.answerCbQuery();
});

// =================== Learn About Base Handler ===================
bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

const baseContent = [
  {
    title: 'Welcome to Base',
    text: 'Base is a secure, low-cost Ethereum Layer 2 network, ideal for fast, affordable crypto transactions.',
  },
  {
    title: 'Why Choose Base?',
    text: '- Lower fees, faster transactions, and Ethereum’s security.\n- Developer-friendly with EVM compatibility.',
  },
  {
    title: 'Getting Started',
    text: 'Bridge assets from Ethereum to Base via [base.org/bridge](https://base.org/bridge).',
  },
  {
    title: 'Learn More',
    text: 'Explore [Base Documentation](https://docs.base.org) for detailed guides.',
  },
];

async function sendBaseContent(ctx, index, isNew = true) {
  const content = baseContent[index];
  const totalPages = baseContent.length;
  const navigationButtons = [];
  if (index > 0) navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  if (index < totalPages - 1) navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  navigationButtons.push(Markup.button.callback('🔚 Exit', 'exit_base'));
  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);
  if (isNew) {
    const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await bot.telegram.editMessageText(ctx.chat.id, ctx.session.baseMessageId, null, `**${content.title}**\n\n${content.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
      ctx.session.baseMessageId = sentMessage.message_id;
    }
  }
}

bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    await ctx.answerCbQuery('⚠️ Invalid page. Try again.', { show_alert: true });
    return;
  }
  await sendBaseContent(ctx, index, false);
  await ctx.answerCbQuery();
});

bot.action('exit_base', async (ctx) => {
  if (ctx.session.baseMessageId) {
    await bot.telegram.deleteMessage(ctx.chat.id, ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.replyWithMarkdown('Thanks for learning about Base!', getMainMenu());
  await ctx.answerCbQuery();
});

// =================== Transactions Handler ===================
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  const pageSize = 5;
  let page = ctx.session.transactionsPage || 1;
  let filter = ctx.session.transactionsFilter || 'all';
  const filterOptions = ['all', 'Completed', 'Pending', 'Failed'];
  const assetOptions = ['USDC', 'USDT', 'All'];
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Fetching transactions...');
  try {
    let query = db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc');
    if (filter !== 'all') query = query.where('status', '==', filter);
    if (filter !== 'All' && assetOptions.includes(filter)) query = query.where('asset', '==', filter);
    const transactionsSnapshot = await query.limit(pageSize * page).get();
    const transactionsCount = transactionsSnapshot.size;
    const transactions = transactionsSnapshot.docs.slice((page - 1) * pageSize, page * pageSize);
    let message = `💰 *Transaction History* (Page ${page}):\n\n`;
    if (transactions.length === 0) message += 'No transactions found.';
    else {
      transactions.forEach((doc, index) => {
        const tx = doc.data();
        message += `*${index + 1}.* *Ref ID:* \`${tx.referenceId}\`\n` +
          `   *Amount:* ${tx.amount} ${tx.asset} on ${tx.chain}\n` +
          `   *Status:* ${tx.status}\n` +
          `   *Payout:* ₦${tx.payout || 'N/A'}\n` +
          `   *Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
      });
    }
    const totalPages = Math.ceil(transactionsCount / pageSize);
    const navigationButtons = [
      Markup.button.callback('⬅️ Prev', `transactions_page_${Math.max(1, page - 1)}_${filter}`),
      Markup.button.callback('Next ➡️', `transactions_page_${Math.min(totalPages, page + 1)}_${filter}`),
      Markup.button.callback('🔄 Refresh', `transactions_page_${page}_${filter}`)
    ];
    const filterButtons = filterOptions.map(status =>
      Markup.button.callback(status.charAt(0).toUpperCase() + status.slice(1), `transactions_filter_${status}`)
    );
    const assetButtons = assetOptions.map(asset =>
      Markup.button.callback(asset, `transactions_filter_${asset}`)
    );
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([navigationButtons, filterButtons, assetButtons]).reply_markup
    });
    ctx.session.transactionsPage = page;
    ctx.session.transactionsFilter = filter;
  } catch (error) {
    logger.error(`Error fetching transactions for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Can’t fetch transactions. Try again later.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Transaction fetch failed.', reply_markup: getMainMenu().reply_markup });
  }
});

bot.action(/transactions_page_(\d+)_([^_]+)/, async (ctx) => {
  ctx.session.transactionsPage = parseInt(ctx.match[1], 10);
  ctx.session.transactionsFilter = ctx.match[2];
  await ctx.answerCbQuery();
  await bot.hears('💰 Transactions')(ctx);
});

bot.action(/transactions_filter_([^_]+)/, async (ctx) => {
  ctx.session.transactionsFilter = ctx.match[1];
  ctx.session.transactionsPage = 1;
  await ctx.answerCbQuery();
  await bot.hears('💰 Transactions')(ctx);
});

// =================== Feedback Handler ===================
bot.hears('📝 Feedback', async (ctx) => {
  await ctx.replyWithMarkdown(`📝 *Feedback*\n\nHow was your DirectPay experience?`, Markup.inlineKeyboard([
    [Markup.button.callback('👍 Great', 'feedback_great')],
    [Markup.button.callback('👎 Not Good', 'feedback_not_good')],
    [Markup.button.callback('🤔 Suggestions', 'feedback_suggestions')]
  ]));
});

bot.action(/feedback_(.+)/, async (ctx) => {
  const feedbackType = ctx.match[1];
  const feedbackMessage = `*Thanks for your feedback!*\n\nYou said: ${feedbackType === 'great' ? 'Great' : feedbackType === 'not_good' ? 'Not Good' : 'Suggestions'}.`;
  await bot.telegram.editMessageText(ctx.chat.id, ctx.update.callback_query.message.message_id, null, feedbackMessage, { parse_mode: 'Markdown' });
  await ctx.replyWithMarkdown('Menu:', getMainMenu());
  logger.info(`User ${ctx.from.id} feedback: ${feedbackType}`);
  await ctx.answerCbQuery();
});

// =================== View Current Rates Handler ===================
bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Fetching current rates...');
  try {
    const paycrestRates = {};
    for (const asset of SUPPORTED_ASSETS) {
      paycrestRates[asset] = exchangeRates[asset] || 0;
    }
    const coingeckoRates = {};
    for (const asset of SUPPORTED_ASSETS) {
      coingeckoRates[asset] = await fetchCoinGeckoRate(asset) || 0;
    }
    let rateComparison = `📈 *Current Exchange Rates (as of ${new Date().toLocaleTimeString('en-US', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' })} WAT)*\n\n`;
    for (const asset of SUPPORTED_ASSETS) {
      const paycrestRate = paycrestRates[asset];
      const coingeckoRate = coingeckoRates[asset];
      const rateDiff = Math.abs(paycrestRate - coingeckoRate);
      rateComparison += `• *${asset}*\n` +
        `  - DirectPay Rate: ₦${paycrestRate.toFixed(2)}\n` +
        `  - Market Rate (CoinGecko): ₦${coingeckoRate.toFixed(2)}\n`;
      if (rateDiff > 0 && asset === 'USDC') {
        const potentialLoss = rateDiff * 100;
        if (rateDiff === 100) rateComparison += `  - *Omo, you’d lose 10k if you sold 100 USDC elsewhere! Stick with DirectPay, abeg!*\n`;
        else if (rateDiff > 100) rateComparison += `  - *Chai, you’d lose ₦${potentialLoss.toFixed(2)} selling 100 USDC on other platforms! DirectPay saves the day, my guy!*\n`;
        else if (rateDiff > 0 && rateDiff < 100) rateComparison += `  - *Small win—save ₦${potentialLoss.toFixed(2)} using DirectPay over others, but na small cruise!*\n`;
        else if (rateDiff === 0) rateComparison += `  - *No difference, bro—DirectPay matches market rates perfectly!*\n`;
      }
      rateComparison += '\n';
    }
    rateComparison += `Trust DirectPay for the best rates and peace of mind.`;
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, rateComparison, { parse_mode: 'Markdown' });
    await ctx.replyWithMarkdown('Menu:', getMainMenu());
  } catch (error) {
    logger.error(`Error fetching rates for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Can’t fetch rates right now. Please try again later.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Rate fetch failed.', reply_markup: getMainMenu().reply_markup });
  }
});

// =================== Admin Panel ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('⚠️ Unauthorized access.', getMainMenu());
    return;
  }
  ctx.session.adminMessageId = null;
  await ctx.replyWithMarkdown('👨‍💼 *Admin Panel*\n\nSelect an option:', getAdminMenu());
});

const getAdminMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('📋 Recent Transactions', 'admin_view_transactions')],
  [Markup.button.callback('📨 Send Message', 'admin_send_message')],
  [Markup.button.callback('✅ Mark Paid', 'admin_mark_paid')],
  [Markup.button.callback('👥 View Users', 'admin_view_users')],
  [Markup.button.callback('📢 Broadcast', 'admin_broadcast_message')],
  [Markup.button.callback('🔙 Back', 'admin_back_to_main')],
]);

bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await bot.telegram.editMessageText(ctx.chat.id, ctx.update.callback_query.message.message_id, null, '⚠️ Unauthorized access.', { parse_mode: 'Markdown' });
    await ctx.replyWithMarkdown('Menu:', getMainMenu());
    return ctx.answerCbQuery();
  }
  const action = ctx.match[1];
  const pendingMessage = await ctx.replyWithMarkdown('🔄 Processing...');
  try {
    switch (action) {
      case 'view_transactions':
        const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();
        let message = '📋 *Recent Transactions*:\n\n';
        if (transactionsSnapshot.empty) message += 'No transactions found.';
        else {
          transactionsSnapshot.forEach((doc) => {
            const tx = doc.data();
            message += `*User ID:* ${tx.userId || 'N/A'}\n` +
              `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
              `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n` +
              `*Status:* ${tx.status || 'Pending'}\n` +
              `*Chain:* ${tx.chain || 'N/A'}\n` +
              `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
          });
        }
        await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, message, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup
        });
        break;
      case 'send_message':
        await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '📨 Preparing to send message...', { parse_mode: 'Markdown' });
        await ctx.scene.enter('send_message_scene');
        break;
      case 'mark_paid':
        const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
        if (pendingTransactions.empty) {
          await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, 'No pending transactions found.', { parse_mode: 'Markdown' });
        } else {
          const batch = db.batch();
          pendingTransactions.forEach((transaction) => {
            batch.update(db.collection('transactions').doc(transaction.id), { status: 'Paid' });
          });
          await batch.commit();
          pendingTransactions.forEach(async (transaction) => {
            const txData = transaction.data();
            const userState = await getUserState(txData.userId);
            if (userState.alertsEnabled) {
              await bot.telegram.sendMessage(txData.userId,
                `🎉 *Transaction Completed!*\n\n` +
                `Your order for ${txData.amount} ${txData.asset} on ${txData.chain} is now paid. Check details in '💰 Transactions'.`,
                { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup }
              );
            }
            logger.info(`Notified user ${txData.userId} about paid transaction ${txData.referenceId}`);
          });
          await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '✅ All pending transactions marked as paid.', { parse_mode: 'Markdown' });
        }
        await ctx.replyWithMarkdown('Admin menu:', getAdminMenu());
        break;
      case 'view_users':
        const usersSnapshot = await db.collection('users').get();
        let usersMessage = '👥 *All Users*:\n\n';
        if (usersSnapshot.empty) usersMessage += 'No users found.';
        else {
          usersSnapshot.forEach((doc) => {
            const user = doc.data();
            usersMessage += `*User ID:* ${doc.id}\n` +
              `*Name:* ${user.firstName || 'N/A'}\n` +
              `*Wallets:* ${user.wallets.length}\n` +
              `*Bank Linked:* ${user.wallets.some(w => w.bank) ? 'Yes' : 'No'}\n\n`;
          });
        }
        await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, usersMessage, {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup
        });
        break;
      case 'broadcast_message':
        await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '📢 Preparing to broadcast...', { parse_mode: 'Markdown' });
        await ctx.scene.enter('broadcast_scene');
        break;
      case 'back_to_main':
        const userState = await getUserState(userId);
        const greeting = userState.wallets.length > 0
          ? `👋 Hello, ${userState.firstName}!\n\nWelcome back to **DirectPay**.`
          : `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Generate a wallet to get started!`;
        await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, greeting, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('Menu:', getMainMenu());
        break;
      default:
        await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Unknown action. Choose an option from the menu.', { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('Admin menu:', getAdminMenu());
    }
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_${action} for ${userId}: ${error.message}`);
    await bot.telegram.editMessageText(pendingMessage.chat.id, pendingMessage.message_id, null, '❌ Failed to process admin action. Try again.', { parse_mode: 'Markdown' });
    await bot.telegram.sendPhoto(userId, errorImage, { caption: 'Admin action failed.', reply_markup: getAdminMenu().reply_markup });
    await ctx.answerCbQuery();
  }
});

// =================== Webhook Handlers ===================
async function updateTransactionStatus(userId, transactionId, newStatus) {
  const transactionRef = db.collection('transactions').doc(transactionId);
  const transaction = await transactionRef.get();
  if (!transaction.exists) {
    logger.error(`Transaction ${transactionId} not found for ${userId}`);
    return;
  }
  const txData = transaction.data();
  if (txData.messageId) {
    const statusUpdateMessage = `🎉 *Transaction Update*\n\n` +
      `*Ref ID:* \`${txData.referenceId}\`\n` +
      `*Status:* ${newStatus}\n` +
      `*Amount:* ${txData.amount} ${txData.asset} on ${txData.chain}\n` +
      `*Date:* ${new Date(txData.timestamp).toLocaleString()}`;
    await bot.telegram.editMessageCaption(userId, txData.messageId, null, statusUpdateMessage, { parse_mode: 'Markdown' });
  }
  await transactionRef.update({ status: newStatus });
  const userState = await getUserState(userId);
  if (userState.alertsEnabled && newStatus === 'Completed') {
    await bot.telegram.sendMessage(userId,
      `🎉 *Transaction Done!*\n\n` +
      `Your ${txData.amount} ${txData.asset} on ${txData.chain} is complete. View details in '💰 Transactions'.`,
      { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup }
    );
  }
}

app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.body;
  if (!signature) {
    logger.error('No Paycrest signature in headers.');
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
    logger.error(`Failed to parse Paycrest webhook: ${error.message}`);
    return res.status(400).send('Invalid JSON.');
  }
  const event = parsedBody.event;
  const data = parsedBody.data;
  logger.info(`Received Paycrest event: ${event}`);
  try {
    const orderId = data.id;
    const amountPaid = parseFloat(data.amountPaid) || 0;
    const reference = data.reference;
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();
    if (txSnapshot.empty) {
      logger.error(`No transaction for Paycrest order ${orderId}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ No transaction found for order ${orderId}.`, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userFirstName = txData.firstName || 'User';
    switch (event) {
      case 'payment_order.pending':
        await bot.telegram.sendMessage(userId, `Processing your order. Updates coming soon.`, { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Order Pending*\n\n*User:* ${userFirstName} (ID: ${userId})\n*Ref ID:* ${reference}\n*Amount:* ₦${amountPaid}`, { parse_mode: 'Markdown' });
        break;
      case 'payment_order.settled':
        await updateTransactionStatus(userId, txDoc.id, 'Completed');
        await bot.telegram.sendPhoto(userId, paymentSettledImage, {
          caption: `🎉 *Funds Credited!*\n\n` +
            `Hello ${userFirstName},\n\n` +
            `Your order is complete:\n\n` +
            `*Crypto:* ${txData.amount} ${txData.asset}\n` +
            `*Payout:* ₦${txData.payout}\n` +
            `*Network:* ${txData.chain}\n` +
            `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
            `Thanks for choosing DirectPay!`,
          parse_mode: 'Markdown',
          reply_markup: getMainMenu().reply_markup
        });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Order Settled*\n\n*User:* ${userFirstName} (ID: ${userId})\n*Ref ID:* ${reference}\n*Amount:* ₦${amountPaid}`, { parse_mode: 'Markdown' });
        break;
      case 'payment_order.expired':
        await updateTransactionStatus(userId, txDoc.id, 'Expired');
        await bot.telegram.sendMessage(userId, `⚠️ *Order Expired*\n\n` +
          `Hello ${userFirstName},\n\n` +
                    `Your order (Ref ID: ${reference}) expired due to processing issues. Funds returned to your source.\n\n` +
          `Contact support if needed.`, { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⏰ *Order Expired*\n\n*User:* ${userFirstName} (ID: ${userId})\n*Ref ID:* ${reference}`, { parse_mode: 'Markdown' });
        break;
      case 'payment_order.refunded':
        await updateTransactionStatus(userId, txDoc.id, 'Refunded');
        await bot.telegram.sendMessage(userId, `❌ *Order Refunded*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `Your order (Ref ID: ${reference}) was refunded due to issues. Funds returned to your source.\n\n` +
          `Contact support if needed.`, { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Order Refunded*\n\n*User:* ${userFirstName} (ID: ${userId})\n*Ref ID:* ${reference}\n*Amount:* ₦${amountPaid}`, { parse_mode: 'Markdown' });
        break;
      default:
        logger.info(`Unhandled Paycrest event: ${event}`);
    }
    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Paycrest webhook error: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Paycrest webhook failed: ${error.message}`, { parse_mode: 'Markdown' });
    res.status(500).send('Error');
  }
});

function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(requestBody);
  const calculatedSignature = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(calculatedSignature), Buffer.from(signatureHeader));
}

app.post(WEBHOOK_BLOCKRADAR_PATH, bodyParser.json(), async (req, res) => {
  try {
    const event = req.body;
    if (!event) {
      logger.error('No data in Blockradar webhook.');
      return res.status(400).send('No data.');
    }
    logger.info(`Blockradar webhook received: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);
    const eventType = event.event || 'Unknown';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || event.data?.asset || 'N/A'; // Fixed to handle object or string
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';
    const senderAddress = event.data?.senderAddress || 'N/A';
    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain in webhook: ${chainRaw}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Unknown chain: ${chainRaw}`, { parse_mode: 'Markdown' });
      return res.status(400).send('Unknown chain.');
    }
    const chain = chainKey;
    if (eventType === 'deposit.success') {
      if (walletAddress === 'N/A') {
        logger.error('Missing wallet address in Blockradar webhook.');
        return res.status(400).send('Missing wallet address.');
      }
      const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
      if (!existingTxSnapshot.empty) {
        logger.info(`Duplicate transaction detected: ${transactionHash}`);
        return res.status(200).send('OK');
      }
      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user found for wallet ${walletAddress}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user for wallet: ${walletAddress}`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find(w => w.address === walletAddress);
      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 *Deposit Received:* ${amount} ${asset} on ${chain}.\nLink a bank account to proceed with payout.`, { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} received ${amount} ${asset} but has no bank linked.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      if (!['USDC', 'USDT'].includes(asset)) {
        await bot.telegram.sendMessage(userId, `⚠️ *Unsupported Asset:* ${amount} ${asset} on ${chain}.\nOnly USDC and USDT are supported. Contact support for assistance.`, { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset}`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      const blockradarRate = event.data?.rate || 0;
      const paycrestRate = exchangeRates[asset] || 0;
      const ngnAmount = calculatePayoutWithFee(amount, paycrestRate, 0.5);
      const referenceId = generateReferenceId();
      const { bankName, accountNumber, accountName } = wallet.bank || { bankName: 'N/A', accountNumber: 'N/A', accountName: userState.firstName || 'User' };
      const transactionRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: wallet.bank,
        payout: ngnAmount,
        timestamp: new Date().toISOString(),
        status: 'Pending',
        paycrestOrderId: '',
        messageId: null,
        firstName: userState.firstName || 'User',
      });
      const depositMessage = await bot.telegram.sendPhoto(userId, depositSuccessImage, {
        caption: `🎉 *Deposit Received* ⏳\n\n` +
          `*Amount:* ${amount} ${asset} on ${chain}\n` +
          `*Ref ID:* ${referenceId}\n` +
          `*Rate:* ₦${blockradarRate} per ${asset} (Blockradar)\n` +
          `*Estimated Payout:* ₦${ngnAmount.toFixed(2)}\n` +
          `*Time:* ${new Date().toLocaleString()}\n` +
          `*Bank:* ${bankName} (****${accountNumber.slice(-4)})\n` +
          `*Holder:* ${accountName}\n\n` +
          `Processing your payout. We’ll update you soon.`,
        parse_mode: 'Markdown',
        reply_markup: getMainMenu().reply_markup
      });
      await transactionRef.update({ messageId: depositMessage.message_id });
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚡️ *New Deposit*\n\n` +
        `*User:* ${userState.firstName} (ID: ${userId})\n` +
        `*Amount:* ${amount} ${asset} on ${chain}\n` +
        `*Rate:* ₦${blockradarRate} per ${asset}\n` +
        `*Payout:* ₦${ngnAmount.toFixed(2)}\n` +
        `*Time:* ${new Date().toLocaleString()}\n` +
        `*Bank:* ${bankName} (****${accountNumber.slice(-4)})\n` +
        `*Ref ID:* ${referenceId}\n` +
        `*Hash:* ${transactionHash}`, { parse_mode: 'Markdown' });
      res.status(200).send('OK');
    } else if (eventType === 'deposit.swept.success') {
      const txSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).limit(1).get();
      if (txSnapshot.empty) {
        logger.error(`No transaction for hash: ${transactionHash}`);
        return res.status(200).send('OK');
      }
      const txDoc = txSnapshot.docs[0];
      const txData = txDoc.data();
      if (['Completed', 'Processing', 'Failed'].includes(txData.status)) {
        logger.info(`Transaction ${transactionHash} already processed. Status: ${txData.status}`);
        return res.status(200).send('OK');
      }
      const paycrestMapping = mapToPaycrest(txData.asset, txData.chain);
      if (!paycrestMapping) {
        logger.error(`No Paycrest mapping for ${txData.asset} on ${txData.chain}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No mapping for ${txData.asset} on ${txData.chain}.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(txData.userId, txData.amount, txData.asset, txData.chain, txData.bankDetails, senderAddress);
        await txDoc.ref.update({ paycrestOrderId: paycrestOrder.id });
      } catch (error) {
        logger.error(`Paycrest order error for ${txData.userId}: ${error.message}`);
        await txDoc.ref.update({ status: 'Failed' });
        await bot.telegram.editMessageCaption(txData.userId, txData.messageId, null, `⚠️ *Payout Issue*\n\n` +
          `We encountered an issue. A refund is in progress (3-5 mins). Contact support if needed.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Paycrest order failed for ${txData.userId}: ${error.message}`, { parse_mode: 'Markdown' });
        return res.status(500).send('Paycrest error');
      }
      const receiveAddress = paycrestOrder.receiveAddress;
      let blockradarAssetId;
      switch (txData.asset) {
        case 'USDC': blockradarAssetId = chains[txData.chain].assets['USDC']; break;
        case 'USDT': blockradarAssetId = chains[txData.chain].assets['USDT']; break;
        default: throw new Error(`Unsupported asset: ${txData.asset}`);
      }
      try {
        await withdrawFromBlockradar(txData.chain, blockradarAssetId, receiveAddress, txData.amount, paycrestOrder.id, { userId: txData.userId, originalTxHash: transactionHash });
      } catch (error) {
        logger.error(`Blockradar withdrawal error for ${txData.userId}: ${error.message}`);
        await txDoc.ref.update({ status: 'Failed' });
        await bot.telegram.editMessageCaption(txData.userId, txData.messageId, null, `⚠️ *Payout Issue*\n\n` +
          `We encountered an issue. A refund is in progress (3-5 mins). Contact support if needed.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Blockradar withdrawal failed for ${txData.userId}: ${error.message}`, { parse_mode: 'Markdown' });
        return res.status(500).send('Blockradar error');
      }
      await txDoc.ref.update({ status: 'Processing' });
      await bot.telegram.editMessageCaption(txData.userId, txData.messageId, null, `🎉 *Deposit Confirmed* 🔄\n\n` +
        `*Amount:* ${txData.amount} ${txData.asset} on ${txData.chain}\n` +
        `*Ref ID:* ${txData.referenceId}\n` +
        `*Hash:* ${transactionHash}\n` +
        `Payout processing started. We’ll notify you when complete.`, { parse_mode: 'Markdown' });
      logger.info(`Deposit swept for ${txData.userId}: ${paycrestOrder.id}`);
      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Blockradar webhook error: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Blockradar webhook failed: ${error.message}`, { parse_mode: 'Markdown' });
    res.status(500).send('Error');
  }
});

// =================== Shutdown Handlers ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// =================== Start Express Server ===================
app.use(WEBHOOK_PATH, bodyParser.json());

app.post(WEBHOOK_PATH, bodyParser.json(), (req, res) => {
  if (!req.body) {
    logger.error('No body in Telegram webhook.');
    return res.status(400).send('No body.');
  }
  logger.info(`Telegram update received: ${JSON.stringify(req.body, null, 2)}`);
  bot.handleUpdate(req.body, res);
});

const SERVER_PORT = PORT;
app.listen(SERVER_PORT, () => {
  logger.info(`Server running on port ${SERVER_PORT}`);
});
