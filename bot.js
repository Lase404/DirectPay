// Required Modules
const Web3 = require('web3');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Firebase setup
const serviceAccount = require('./directpayngn-firebase-adminsdk-d11t3-17c3c57aa5.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpayngn.firebaseio.com"
});
const db = admin.firestore();

// API Keys & other credentials 
const BOT_TOKEN = '7404771579:AAEY0HpgC-3ZmFGq0-bToPkAczGbJ-WND-Q';
const PAYSTACK_API_KEY = 'sk_test_cd857e88d5d474db8238d30d027ea2911cd7fa17';
const BLOCKRADAR_API_KEY = 'grD8lJpMPjvjChMo5SnOl0eZmaabikn2z2S2rXKkAxCM1oWsZDMwFQL9LWgrc';
const BLOCKRADAR_WALLET_ID = '83eeb82c-bf7b-4e70-bdd0-ab87b4fbcc2d';
const PERSONAL_CHAT_ID = '2009305288';

// Web3 Setup for Base Testnet
const web3 = new Web3('https://sepolia.base.org');

// Bot Initialization
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// State Management
let userStatesCache = {}; // In-memory cache for quick access
const MAX_WALLETS = 3; // Max wallets per user

// Manual Bank List with Aliases
const bankList = [
  { name: '9mobile 9Payment Service Bank', code: '120001', aliases: ['9PSB', '9mobile PSB'] },
  { name: 'Abbey Mortgage Bank', code: '801', aliases: ['Abbey Mortgage'] },
  { name: 'Above Only MFB', code: '51204', aliases: ['Above Only Microfinance Bank'] },
  { name: 'Abulesoro MFB', code: '51312', aliases: ['Abulesoro Microfinance Bank'] },
  { name: 'Access Bank', code: '044', aliases: ['Access', 'Diamond Bank'] },
  { name: 'Access Bank (Diamond)', code: '063', aliases: ['Access Diamond', 'Diamond Bank'] },
  { name: 'Airtel Smartcash PSB', code: '120004', aliases: ['Smartcash', 'Airtel PSB'] },
  { name: 'ALAT by WEMA', code: '035A', aliases: ['ALAT', 'Wema ALAT'] },
  { name: 'Amju Unique MFB', code: '50926', aliases: ['Amju Unique Microfinance Bank'] },
  { name: 'Aramoko MFB', code: '50083', aliases: ['Aramoko Microfinance Bank'] },
  { name: 'ASO Savings and Loans', code: '401', aliases: ['ASO Savings'] },
  { name: 'Astrapolaris MFB LTD', code: 'MFB50094', aliases: ['Astrapolaris Microfinance Bank'] },
  { name: 'Bainescredit MFB', code: '51229', aliases: ['Bainescredit Microfinance Bank'] },
  { name: 'Bowen Microfinance Bank', code: '50931', aliases: ['Bowen MFB'] },
  { name: 'Carbon', code: '565', aliases: ['Paylater'] },
  { name: 'CEMCS Microfinance Bank', code: '50823', aliases: ['CEMCS MFB'] },
  { name: 'Chanelle Microfinance Bank Limited', code: '50171', aliases: ['Chanelle MFB'] },
  { name: 'Citibank Nigeria', code: '023', aliases: ['Citibank', 'Citi Bank'] },
  { name: 'Corestep MFB', code: '50204', aliases: ['Corestep Microfinance Bank'] },
  { name: 'Coronation Merchant Bank', code: '559', aliases: ['Coronation Bank'] },
  { name: 'Crescent MFB', code: '51297', aliases: ['Crescent Microfinance Bank'] },
  { name: 'Ecobank Nigeria', code: '050', aliases: ['Ecobank'] },
  { name: 'Ekimogun MFB', code: '50263', aliases: ['Ekimogun Microfinance Bank'] },
  { name: 'Ekondo Microfinance Bank', code: '562', aliases: ['Ekondo MFB'] },
  { name: 'Eyowo', code: '50126', aliases: ['Eyowo Microfinance Bank'] },
  { name: 'Fidelity Bank', code: '070', aliases: ['Fidelity'] },
  { name: 'Firmus MFB', code: '51314', aliases: ['Firmus Microfinance Bank'] },
  { name: 'First Bank of Nigeria', code: '011', aliases: ['First Bank', 'FBN'] },
  { name: 'First City Monument Bank', code: '214', aliases: ['FCMB'] },
  { name: 'FSDH Merchant Bank Limited', code: '501', aliases: ['FSDH Bank'] },
  { name: 'Gateway Mortgage Bank LTD', code: '812', aliases: ['Gateway Mortgage Bank'] },
  { name: 'Globus Bank', code: '00103', aliases: ['Globus'] },
  { name: 'GoMoney', code: '100022', aliases: ['Go Money'] },
  { name: 'Guaranty Trust Bank', code: '058', aliases: ['GTBank', 'GTB', 'Guarantee Trust Bank'] },
  { name: 'Hackman Microfinance Bank', code: '51251', aliases: ['Hackman MFB'] },
  { name: 'Hasal Microfinance Bank', code: '50383', aliases: ['Hasal MFB'] },
  { name: 'Heritage Bank', code: '030', aliases: ['Heritage'] },
  { name: 'HopePSB', code: '120002', aliases: ['Hope PSB'] },
  { name: 'Ibile Microfinance Bank', code: '51244', aliases: ['Ibile MFB'] },
  { name: 'Ikoyi Osun MFB', code: '50439', aliases: ['Ikoyi Osun Microfinance Bank'] },
  { name: 'Infinity MFB', code: '50457', aliases: ['Infinity Microfinance Bank'] },
  { name: 'Jaiz Bank', code: '301', aliases: ['Jaiz'] },
  { name: 'Kadpoly MFB', code: '50502', aliases: ['Kadpoly Microfinance Bank'] },
  { name: 'Keystone Bank', code: '082', aliases: ['Keystone'] },
  { name: 'Kredi Money MFB LTD', code: '50200', aliases: ['Kredi Money'] },
  { name: 'Kuda Bank', code: '50211', aliases: ['Kuda'] },
  { name: 'Lagos Building Investment Company Plc.', code: '90052', aliases: ['LBIC'] },
  { name: 'Links MFB', code: '50549', aliases: ['Links Microfinance Bank'] },
  { name: 'Living Trust Mortgage Bank', code: '031', aliases: ['Living Trust Bank'] },
  { name: 'Lotus Bank', code: '303', aliases: ['Lotus'] },
  { name: 'Mayfair MFB', code: '50563', aliases: ['Mayfair Microfinance Bank'] },
  { name: 'Mint MFB', code: '50304', aliases: ['Mint Microfinance Bank'] },
  { name: 'MTN Momo PSB', code: '120003', aliases: ['Momo PSB', 'MTN PSB'] },
  { name: 'Paga', code: '100002', aliases: ['Pagatech', 'PagaPay'] },
  { name: 'PalmPay', code: '999991', aliases: ['Palm Pay'] },
  { name: 'Parallex Bank', code: '104', aliases: ['Parallex'] },
  { name: 'Parkway - ReadyCash', code: '311', aliases: ['ReadyCash', 'Parkway'] },
  { name: 'Paycom', code: '999992', aliases: ['OPay', 'Paycom'] },
  { name: 'Petra Mircofinance Bank Plc', code: '50746', aliases: ['Petra MFB'] },
  { name: 'Polaris Bank', code: '076', aliases: ['Polaris'] },
  { name: 'Polyunwana MFB', code: '50864', aliases: ['Polyunwana Microfinance Bank'] },
  { name: 'PremiumTrust Bank', code: '105', aliases: ['Premium Trust Bank'] },
  { name: 'Providus Bank', code: '101', aliases: ['Providus'] },
  { name: 'QuickFund MFB', code: '51293', aliases: ['QuickFund Microfinance Bank'] },
  { name: 'Rand Merchant Bank', code: '502', aliases: ['RMB'] },
  { name: 'Refuge Mortgage Bank', code: '90067', aliases: ['Refuge Mortgage'] },
  { name: 'Rubies MFB', code: '125', aliases: ['Rubies Bank'] },
  { name: 'Safe Haven MFB', code: '51113', aliases: ['Safe Haven Microfinance Bank'] },
  { name: 'Solid Rock MFB', code: '50800', aliases: ['Solid Rock Microfinance Bank'] },
  { name: 'Sparkle Microfinance Bank', code: '51310', aliases: ['Sparkle'] },
  { name: 'Stanbic IBTC Bank', code: '221', aliases: ['Stanbic', 'IBTC', 'Stanbic Bank'] },
  { name: 'Standard Chartered Bank', code: '068', aliases: ['Standard Chartered', 'StanChart'] },
  { name: 'Stellas MFB', code: '51253', aliases: ['Stellas Microfinance Bank'] },
  { name: 'Sterling Bank', code: '232', aliases: ['Sterling'] },
  { name: 'Suntrust Bank', code: '100', aliases: ['SunTrust'] },
  { name: 'TAJ Bank', code: '302', aliases: ['TAJ'] },
  { name: 'Tangerine Money', code: '51269', aliases: ['Tangerine'] },
  { name: 'TCF MFB', code: '51211', aliases: ['TCF Microfinance Bank'] },
  { name: 'Titan Bank', code: '102', aliases: ['Titan Trust Bank'] },
  { name: 'Titan Paystack', code: '100039', aliases: ['Paystack Bank'] },
  { name: 'Unical MFB', code: '50871', aliases: ['Unical Microfinance Bank'] },
  { name: 'Union Bank of Nigeria', code: '032', aliases: ['Union Bank'] },
  { name: 'United Bank For Africa', code: '033', aliases: ['UBA'] },
  { name: 'Unity Bank', code: '215', aliases: ['Unity'] },
  { name: 'VFD Microfinance Bank Limited', code: '566', aliases: ['VFD MFB', 'V Bank'] },
  { name: 'Wema Bank', code: '035', aliases: ['Wema'] },
  { name: 'Zenith Bank', code: '057', aliases: ['Zenith'] },
];

// Utility Functions


async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}


function calculatePayout(asset, amount) {
  const rates = { USDC: 1641.81, USDT: 1641.81, ETH: 3968483.33, BNB: 300000 }; // Add more assets and rates as needed
  return (amount * rates[asset]).toFixed(2);
}


function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}


const getMainMenu = (walletExists) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
  ]).resize();


const adminMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📄 View Transactions', 'admin_view_transactions')],
  [Markup.button.callback('✉️ Send Message', 'admin_send_message')],
  [Markup.button.callback('💳 Mark Paid', 'admin_mark_paid')],
  [Markup.button.callback('🖼️ Upload Image', 'admin_upload_image')],
]);


const isAdmin = (userId) => userId.toString() === PERSONAL_CHAT_ID;


async function getUserState(userId) {
  // Check in-memory cache first
  if (userStatesCache[userId]) {
    return userStatesCache[userId];
  }

  // Fetch from Firestore
  const doc = await db.collection('userStates').doc(userId).get();
  if (doc.exists) {
    userStatesCache[userId] = doc.data();
    return doc.data();
  } else {
    // Initialize new user state
    const newUserState = { wallets: [], awaitingBankName: false, awaitingAccountNumber: false, awaitingUserIdForMessage: false, awaitingMessageContent: false };
    userStatesCache[userId] = newUserState;
    await db.collection('userStates').doc(userId).set(newUserState);
    return newUserState;
  }
}


async function saveUserState(userId, userState) {
  userStatesCache[userId] = userState;
  await db.collection('userStates').doc(userId).set(userState);
}

/**
 * Generate a Base Wallet and Save to Firestore
 * @returns {string} Wallet Address
 */
async function generateBaseWallet(userId) {
  try {
    const response = await axios.post(
      `https://api.blockradar.co/v1/wallets/${BLOCKRADAR_WALLET_ID}/addresses`,
      { name: 'DirectPay_User_Wallet' },
      { headers: { 'x-api-key': BLOCKRADAR_API_KEY } }
    );
    const walletAddress = response.data.data.address;

    // Save wallet to 'wallets' collection
    await db.collection('wallets').doc(walletAddress).set({
      userId,
      address: walletAddress,
      bank: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return walletAddress;
  } catch (error) {
    throw new Error('Error generating wallet');
  }
}

/**
 * Send Learn About Base Content with Pagination by Editing Existing Message
 * @param {object} ctx
 * @param {number} index
 */
async function sendBaseContent(ctx, index) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];

  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  }

  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }

  try {
    await ctx.editMessageText(`*${content.title}*\n\n${content.text}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(navigationButtons),
    });
  } catch (error) {
    // If message can't be edited, send a new one
    await ctx.replyWithMarkdown(`*${content.title}*\n\n${content.text}`, Markup.inlineKeyboard(navigationButtons));
  }
}

// Learn About Base Content
const baseContent = [
  {
    title: 'Welcome to Base',
    text: 'Base is a secure, low-cost, and developer-friendly Ethereum Layer 2 network. It offers a seamless way to onboard into the world of decentralized applications.',
  },
  {
    title: 'Why Choose Base?',
    text: '- **Lower Fees**: Significantly reduced transaction costs.\n- **Faster Transactions**: Swift confirmation times.\n- **Secure**: Built on Ethereum’s robust security.\n- **Developer-Friendly**: Compatible with EVM tools and infrastructure.',
  },
  {
    title: 'Getting Started',
    text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at https://base.org/bridge.',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at https://docs.base.org for in-depth guides and resources.',
  },
];

// Greet User Function
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletExists = userState.wallets.length > 0;

  const greeting = walletExists
    ? `👋 Hey, ${ctx.from.first_name}! Welcome back onchain with DirectPay! 🚀\n\nYour seamless journey continues. Manage your wallets and transactions below, and keep enjoying instant cashouts from your crypto assets. Let's keep things rolling!`
    : `👋 Hello, ${ctx.from.first_name}! Welcome to DirectPay!\n\nSay goodbye to delays and complicated P2P transactions. With DirectPay, you can easily send stablecoins and receive cash directly in your bank account within minutes. No KYC, no hassle—just quick and secure transactions.\n\nLet’s get started!\n\n1. **Add Your Bank Account**\n2. **Get Your Dedicated Wallet Address**\n3. **Send Stablecoins and receive cash instantly.**\n\nWe’ve got the best rates and real-time updates to keep you informed every step of the way. Your funds are safe, and you’ll have cash in your account in no time!`;

  // Send greeting message
  await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists));

  // If user is admin, send admin menu
  if (isAdmin(userId)) {
    await ctx.reply('🔑 Welcome to the Admin Panel:', adminMenu);
  }
}

// Handle /start Command
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    console.error('Error in /start command:', error);
    await ctx.reply('An error occurred. Please try again later.');
  }
});

// Generate Wallet Handler
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  const generatingMessage = await ctx.reply('🔄 Generating Wallet... Please wait a moment.');

  try {
    const walletAddress = await generateBaseWallet(userId);
    userState.wallets.push({ address: walletAddress, bank: null });
    await saveUserState(userId, userState); // Save user state

    // Update Menu
    await ctx.replyWithMarkdown(`✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``, getMainMenu(true));

    // Prompt to Link Bank Account
    await ctx.reply('Please link a bank account to receive your payouts.', Markup.keyboard(['🏦 Link Bank Account']).resize());

    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId}: ${walletAddress}`);
  } catch (error) {
    console.error('Error generating wallet:', error);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`);
  }
});

// View Wallet Handler
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (!userState || userState.wallets.length === 0) {
    return ctx.reply('You have no wallets. Generate a new wallet below.', getMainMenu(false));
  }

  // Display Wallets
  let walletMessage = '💼 **Your Wallets**:\n\n';
  userState.wallets.forEach((wallet, index) => {
    walletMessage += `#${index + 1} Wallet Address: \`${wallet.address}\`\n`;
    walletMessage += `🔗 Linked Bank: ${wallet.bank ? 'Yes' : 'No'}\n\n`;
  });

  const canCreateNewWallet = userState.wallets[0].bank;

  await ctx.replyWithMarkdown(walletMessage, Markup.inlineKeyboard([
    canCreateNewWallet
      ? [Markup.button.callback('➕ Create New Wallet', 'create_new_wallet')]
      : [Markup.button.callback('🔗 Link Bank to Create New Wallet', 'link_bank')],
  ]));
});

// Create New Wallet Action
bot.action('create_new_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (!userState.wallets[0].bank) {
    return ctx.reply('⚠️ You must link a bank to your first wallet before creating a new one.');
  }

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  const generatingMessage = await ctx.reply('🔄 Generating a new wallet... Please wait a moment.');

  try {
    const walletAddress = await generateBaseWallet(userId);
    userState.wallets.push({ address: walletAddress, bank: null });
    await saveUserState(userId, userState); // Save user state

    await ctx.replyWithMarkdown(`✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``, getMainMenu(true));

    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 New wallet generated for user ${userId}: ${walletAddress}`);
  } catch (error) {
    console.error('Error generating new wallet:', error);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating new wallet for user ${userId}: ${error.message}`);
  }
});

// Link Bank Account Handler
bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  // Check if user has wallets
  if (!userState || userState.wallets.length === 0) {
    return ctx.reply('⚠️ You need to generate a wallet before linking a bank account.');
  }

  // Find the first wallet without a linked bank
  const walletIndex = userState.wallets.findIndex((wallet) => !wallet.bank);

  if (walletIndex === -1) {
    return ctx.reply('All your wallets already have a linked bank account.');
  }

  userState.currentWalletIndex = walletIndex;
  userState.awaitingBankName = true;
  await saveUserState(userId, userState); // Save user state

  await ctx.reply('Please enter your bank name (e.g., Access Bank):');
});

// Handle Bank Name and Account Number Input
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.awaitingBankName) {
    const bankNameInput = ctx.message.text.trim().toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      return ctx.reply('❌ Invalid bank name. Please enter a valid bank name:');
    }

    userState.bankCode = bank.code;
    userState.bankName = bank.name;
    userState.awaitingBankName = false;
    userState.awaitingAccountNumber = true;
    await saveUserState(userId, userState); // Save user state

    return ctx.reply('Please enter your bank account number (10 digits):');
  } else if (userState.awaitingAccountNumber) {
    const accountNumber = ctx.message.text.trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      return ctx.reply('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    userState.accountNumber = accountNumber;
    await saveUserState(userId, userState); // Save user state

    // Verify Bank Account
    await ctx.reply('🔄 Verifying your bank details...');

    try {
      const verificationResult = await verifyBankAccount(accountNumber, userState.bankCode);

      const accountName = verificationResult.data.account_name;
      userState.accountName = accountName;

      // Ask for Confirmation
      await ctx.replyWithMarkdown(
        `🏦 **Bank Account Verification**\n\nBank Name: *${userState.bankName}*\nAccount Number: *${userState.accountNumber}*\nAccount Holder: *${accountName}*\n\nIs this correct?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Yes', 'confirm_bank_yes'),
          Markup.button.callback('❌ No', 'confirm_bank_no'),
        ])
      );
    } catch (error) {
      console.error('Error verifying bank account:', error);
      await ctx.reply('❌ Failed to verify bank account. Please try again later.');
      userState.awaitingBankName = true;
      userState.awaitingAccountNumber = false;
      await saveUserState(userId, userState); // Save user state
      return ctx.reply('Please enter your bank name:');
    }

    userState.awaitingAccountNumber = false;
    await saveUserState(userId, userState); // Save user state
  } else if (isAdmin(userId) && userState.awaitingUserIdForMessage) {
    // Handle Admin Messaging - Step 1: Receive User ID
    const recipientId = ctx.message.text.trim();
    userState.messageRecipientId = recipientId;
    userState.awaitingUserIdForMessage = false;
    userState.awaitingMessageContent = true;
    await saveUserState(userId, userState); // Save user state

    return ctx.reply('Please enter the message you want to send:');
  } else if (isAdmin(userId) && userState.awaitingMessageContent) {
    // Handle Admin Messaging - Step 2: Receive Message Content
    const recipientId = userState.messageRecipientId;
    const messageContent = ctx.message.text.trim();

    try {
      await bot.telegram.sendMessage(recipientId, `📩 *Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
      await ctx.reply('✅ Message sent successfully.');
    } catch (error) {
      console.error('Error sending message to user:', error);
      await ctx.reply('⚠️ Failed to send message to the user.');
    }

    // Reset Admin State
    userState.messageRecipientId = null;
    userState.awaitingMessageContent = false;
    await saveUserState(userId, userState); // Save user state
  } else {
    // Handle other text messages or ignore
    return;
  }
});

// Handle Bank Confirmation
bot.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletIndex = userState.currentWalletIndex;

  if (!userState || walletIndex === undefined || walletIndex === null) {
    console.error(`Invalid userState or walletIndex for userId: ${userId}`);
    return ctx.reply('⚠️ An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
  }

  const wallet = userState.wallets[walletIndex];
  if (!wallet) {
    console.error(`Wallet not found at index ${walletIndex} for userId: ${userId}`);
    return ctx.reply('⚠️ An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
  }

  // Link Bank to Wallet
  wallet.bank = {
    bankName: userState.bankName,
    bankCode: userState.bankCode,
    accountNumber: userState.accountNumber,
    accountName: userState.accountName,
  };

  // Update Firestore
  await saveUserState(userId, userState);

  // Update 'wallets' collection
  await db.collection('wallets').doc(wallet.address).update({
    bank: wallet.bank,
  });

  await ctx.reply('✅ Your bank account has been linked successfully!', getMainMenu(true));

  // Log to Admin
  await bot.telegram.sendMessage(
    PERSONAL_CHAT_ID,
    `🔗 *User ${userId} (${ctx.from.username || 'No Username'}) linked a bank account:*\n\n*Bank Name:* ${wallet.bank.bankName}\n*Account Number:* ${wallet.bank.accountNumber}\n*Account Holder:* ${wallet.bank.accountName}`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  await ctx.reply('⚠️ It seems there was an error. Let\'s try again.');

  // Reset Temp States
  userState.bankName = null;
  userState.bankCode = null;
  userState.accountNumber = null;
  userState.accountName = null;
  userState.awaitingBankName = true;
  userState.awaitingAccountNumber = false;
  await saveUserState(userId, userState); // Save user state

  return ctx.reply('Please enter your bank name:');
});

// Learn About Base Handler
bot.hears('📘 Learn About Base', async (ctx) => {
  await sendBaseContent(ctx, 0);
});

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  await sendBaseContent(ctx, index);
});

// Support Functionality
bot.hears('ℹ️ Support', async (ctx) => {
  await ctx.reply('How can we assist you today?', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  await ctx.reply('DirectPay allows you to receive crypto payments directly into your bank account seamlessly. Generate a wallet, link your bank, and start receiving payments.');
});

bot.action('support_not_received', async (ctx) => {
  await ctx.reply('If you haven’t received your transaction, please ensure that you have linked your bank account. If the issue persists, contact support.');
});

bot.action('support_contact', async (ctx) => {
  await ctx.reply('You can contact our support team at @your_support_username.');
});

// View Transactions Handler
bot.hears('💰 Transactions', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).get();

    if (transactionsSnapshot.empty) {
      return ctx.reply('You have no transactions at the moment.');
    }

    let message = '💰 **Your Transactions**:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* ${tx.referenceId}\n`;
      message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
      message += `*Status:* ${tx.status || 'Pending'}\n`;
      message += `*Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    await ctx.reply('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Admin Functions

/**
 * View All Transactions (Admin)
 */
bot.action('admin_view_transactions', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  try {
    const transactionsSnapshot = await db.collection('transactions').get();

    if (transactionsSnapshot.empty) {
      return ctx.reply('No transactions found.');
    }

    let transactionMessage = '📄 **All Transactions**:\n\n';
    transactionsSnapshot.forEach((transaction) => {
      const data = transaction.data();
      transactionMessage += `*User ID:* ${data.userId}\n`;
      transactionMessage += `*Reference ID:* ${data.referenceId}\n`;
      transactionMessage += `*Amount:* ${data.amount} ${data.asset}\n`;
      transactionMessage += `*Status:* ${data.status || 'Pending'}\n`;
      transactionMessage += `*Date:* ${new Date(data.timestamp).toLocaleString()}\n\n`;
    });

    await ctx.replyWithMarkdown(transactionMessage);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    await ctx.reply('⚠️ Error fetching transactions. Please try again later.');
  }
});

/**
 * Send Message to User (Admin)
 */
bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const userState = await getUserState(userId);
  userState.awaitingUserIdForMessage = true;
  await saveUserState(userId, userState); // Save user state

  await ctx.reply('📩 Please enter the User ID you want to message:');
});

/**
 * Mark Transaction as Paid (Admin)
 */
bot.action('admin_mark_paid', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  try {
    const pendingTransactionsSnapshot = await db.collection('transactions').where('status', '==', 'Pending').get();

    if (pendingTransactionsSnapshot.empty) {
      return ctx.reply('No pending transactions found.');
    }

    // Create a list of pending transactions with buttons to select each
    let message = '💳 **Pending Transactions**:\n\n';
    const transactionButtons = [];

    pendingTransactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* ${tx.referenceId}\n`;
      message += `*User ID:* ${tx.userId}\n`;
      message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
      message += `*Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;

      // Add a button for each transaction
      transactionButtons.push([Markup.button.callback(`Mark ${tx.referenceId} as Paid`, `mark_paid_${tx.referenceId}`)]);
    });

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(transactionButtons));
  } catch (error) {
    console.error('Error fetching pending transactions:', error);
    await ctx.reply('⚠️ Error fetching pending transactions. Please try again later.');
  }
});

/**
 * Upload Image to User (Admin)
 */
bot.action('admin_upload_image', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  // Prompt admin to select a user to upload image to
  try {
    const usersSnapshot = await db.collection('userStates').get();

    if (usersSnapshot.empty) {
      return ctx.reply('No users found.');
    }

    const userButtons = [];
    usersSnapshot.forEach((doc) => {
      const data = doc.data();
      userButtons.push([Markup.button.callback(`User ${doc.id}`, `upload_image_${doc.id}`)]);
    });

    await ctx.reply('🖼️ Select the user you want to upload an image to:', Markup.inlineKeyboard(userButtons));
  } catch (error) {
    console.error('Error fetching users for image upload:', error);
    await ctx.reply('⚠️ Error fetching users. Please try again later.');
  }
});

// Handle Admin Image Upload Selection
bot.action(/upload_image_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const targetUserId = ctx.match[1];

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const userState = await getUserState(userId);
  userState.uploadImageTargetUserId = targetUserId;
  userState.awaitingImage = true;
  await saveUserState(userId, userState); // Save user state

  await ctx.reply('📤 Please upload the image you want to send to the user:');
});

/**
 * Handle Image Upload from Admin to User
 */
bot.on('photo', async (ctx) => {
  const adminId = ctx.from.id.toString();
  const userState = await getUserState(adminId);

  if (userState.awaitingImage && userState.uploadImageTargetUserId) {
    const targetUserId = userState.uploadImageTargetUserId;
    const photo = ctx.message.photo.pop(); // Get the highest resolution photo
    const fileId = photo.file_id;

    try {
      await bot.telegram.sendPhoto(targetUserId, fileId, { caption: '🖼️ *Image from Admin*', parse_mode: 'Markdown' });
      await ctx.reply('✅ Image sent successfully.');
    } catch (error) {
      console.error('Error sending image to user:', error);
      await ctx.reply('⚠️ Failed to send image to the user.');
    }

    // Reset Admin State
    userState.uploadImageTargetUserId = null;
    userState.awaitingImage = false;
    await saveUserState(adminId, userState); // Save user state
  } else {
    // Handle photos from regular users or ignore
    return;
  }
});

// Handle Text Commands (Admin Messaging)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (isAdmin(userId) && userState.awaitingUserIdForMessage) {
    // Handle Admin Messaging - Step 1: Receive User ID
    const recipientId = ctx.message.text.trim();
    userState.messageRecipientId = recipientId;
    userState.awaitingUserIdForMessage = false;
    userState.awaitingMessageContent = true;
    await saveUserState(userId, userState); // Save user state

    return ctx.reply('✉️ Please enter the message you want to send:');
  } else if (isAdmin(userId) && userState.awaitingMessageContent) {
    // Handle Admin Messaging - Step 2: Receive Message Content
    const recipientId = userState.messageRecipientId;
    const messageContent = ctx.message.text.trim();

    try {
      await bot.telegram.sendMessage(recipientId, `📩 *Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
      await ctx.reply('✅ Message sent successfully.');
    } catch (error) {
      console.error('Error sending message to user:', error);
      await ctx.reply('⚠️ Failed to send message to the user.');
    }

    // Reset Admin State
    userState.messageRecipientId = null;
    userState.awaitingMessageContent = false;
    await saveUserState(userId, userState); // Save user state
  } else {
    // Handle other text messages or ignore
    return;
  }
});

// Handle Bank Confirmation
bot.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletIndex = userState.currentWalletIndex;

  if (!userState || walletIndex === undefined || walletIndex === null) {
    console.error(`Invalid userState or walletIndex for userId: ${userId}`);
    return ctx.reply('⚠️ An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
  }

  const wallet = userState.wallets[walletIndex];
  if (!wallet) {
    console.error(`Wallet not found at index ${walletIndex} for userId: ${userId}`);
    return ctx.reply('⚠️ An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
  }

  // Link Bank to Wallet
  wallet.bank = {
    bankName: userState.bankName,
    bankCode: userState.bankCode,
    accountNumber: userState.accountNumber,
    accountName: userState.accountName,
  };

  // Update Firestore
  await saveUserState(userId, userState);

  // Update 'wallets' collection
  await db.collection('wallets').doc(wallet.address).update({
    bank: wallet.bank,
  });

  await ctx.reply('✅ Your bank account has been linked successfully!', getMainMenu(true));

  // Log to Admin
  await bot.telegram.sendMessage(
    PERSONAL_CHAT_ID,
    `🔗 *User ${userId} (${ctx.from.username || 'No Username'}) linked a bank account:*\n\n*Bank Name:* ${wallet.bank.bankName}\n*Account Number:* ${wallet.bank.accountNumber}\n*Account Holder:* ${wallet.bank.accountName}`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  await ctx.reply('⚠️ It seems there was an error. Let\'s try again.');

  // Reset Temp States
  userState.bankName = null;
  userState.bankCode = null;
  userState.accountNumber = null;
  userState.accountName = null;
  userState.awaitingBankName = true;
  userState.awaitingAccountNumber = false;
  await saveUserState(userId, userState); // Save user state

  return ctx.reply('Please enter your bank name:');
});

// Handle "Mark Paid" Transaction Selection
bot.action(/mark_paid_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const referenceId = ctx.match[1];

  try {
    const txQuery = await db.collection('transactions').where('referenceId', '==', referenceId).limit(1).get();

    if (txQuery.empty) {
      return ctx.reply('⚠️ Transaction not found.');
    }

    const txDoc = txQuery.docs[0];
    const txData = txDoc.data();

    if (txData.status === 'Paid') {
      return ctx.reply('⚠️ This transaction has already been marked as paid.');
    }

    // Update transaction status to 'Paid'
    await txDoc.ref.update({ status: 'Paid', paidAt: admin.firestore.FieldValue.serverTimestamp() });

    // Calculate detailed payout info
    const payout = calculatePayout(txData.asset, parseFloat(txData.amount));
    const network = 'BNB Smart Chain'; // Assuming network; adjust as needed

    // Fetch user info from 'userStates'
    const userState = await getUserState(txData.userId);
    const username = (await bot.telegram.getChat(txData.userId)).username || 'No Username';

    // Format the message
    const formattedMessage = `
Hello ${userState.wallets.find(w => w.address === txData.walletAddress).bank.accountName},

We’ve converted the ${txData.amount} ${txData.asset} you deposited and successfully sent NGN ${payout} in your linked account.

*Transaction Details*
• *Crypto Amount:* ${txData.amount} ${txData.asset}
• *Cash Amount:* NGN ${payout}
• *Rate:* ${calculatePayout(txData.asset, 1)} NGN/${txData.asset}
• *Network:* ${network}
• *Receiving Account:* ${userState.wallets.find(w => w.address === txData.walletAddress).bank.bankName} ****${userState.wallets.find(w => w.address === txData.walletAddress).bank.accountNumber.slice(-4)}
• *Date:* ${new Date(txData.timestamp).toLocaleString()}
• *Reference:* ${txData.referenceId}

[View Transaction](https://yourwebsite.com/transaction/${txData.referenceId})

If you have any questions or need further assistance, please contact us; we’d love to help.
`;

    // Send formatted message to user
    await bot.telegram.sendMessage(txData.userId, formattedMessage, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    });

    // Notify Admin of successful marking
    await ctx.reply('✅ Transaction marked as paid and user has been notified.');

    // Log detailed transaction to admin
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `✅ *Transaction Marked as Paid*\n\n*User ID:* ${txData.userId}\n*Username:* ${username}\n*Bank Name:* ${userState.wallets.find(w => w.address === txData.walletAddress).bank.bankName}\n*Account Number:* ****${userState.wallets.find(w => w.address === txData.walletAddress).bank.accountNumber.slice(-4)}\n*Reference ID:* ${txData.referenceId}\n*Amount:* ${txData.amount} ${txData.asset}\n*Payout:* NGN ${payout}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error marking transaction as paid:', error);
    await ctx.reply('⚠️ Error marking transaction as paid. Please try again later.');
  }
});

/**
 * Upload Image to User - Handle Selection
 */
bot.action(/upload_image_(.+)/, async (ctx) => {
  const adminId = ctx.from.id.toString();
  const targetUserId = ctx.match[1];

  if (!isAdmin(adminId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const userState = await getUserState(adminId);
  userState.uploadImageTargetUserId = targetUserId;
  userState.awaitingImage = true;
  await saveUserState(adminId, userState); // Save user state

  await ctx.reply('📤 Please upload the image you want to send to the user:');
});

// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;

    // Avoid sending raw JSON to admin
    // Extract only necessary details
    if (event.event === 'deposit.success') {
      const walletAddress = event.data.address.address;
      const amount = event.data.amount;
      const asset = event.data.asset.symbol;
      const transactionHash = event.data.hash;
      const network = 'BNB Smart Chain'; // Adjust based on actual network

      // Find User by Wallet Address from 'wallets' collection
      const walletDoc = await db.collection('wallets').doc(walletAddress).get();

      if (!walletDoc.exists) {
        console.log(`No user found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      const walletData = walletDoc.data();
      const userId = walletData.userId;

      // Fetch user state
      const userState = await getUserState(userId);

      // Check if Wallet has Linked Bank
      if (!walletData.bank) {
        await bot.telegram.sendMessage(
          userId,
          `💰 *Deposit Received*: ${amount} ${asset}.\n\nPlease link a bank account to receive your payout securely.`,
          { parse_mode: 'Markdown' }
        );
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `⚠️ User ${userId} (${(await bot.telegram.getChat(userId)).username || 'No Username'}) has received a deposit but hasn't linked a bank account.`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, parseFloat(amount));
      const referenceId = generateReferenceId();

      // Notify User of Successful Deposit
      const formattedMessage = `
Hello ${walletData.bank.accountName},

A deposit of ${amount} ${asset} was received on your wallet address: \`${walletAddress}\`.

Your transaction is being processed. You’ll receive NGN ${payout} in your ${walletData.bank.bankName} account ending with ****${walletData.bank.accountNumber.slice(-4)} shortly.

We'll notify you once the process is complete.
`;

      await bot.telegram.sendMessage(userId, formattedMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });

      // Notify Admin with Transaction Details (Formatted)
      const userChat = await bot.telegram.getChat(userId);
      const username = userChat.username || 'No Username';

      const adminMessage = `
⚡️ *New Deposit Received*

*User ID:* ${userId}
*Username:* ${username}
*Bank Name:* ${walletData.bank.bankName}
*Account Number:* ****${walletData.bank.accountNumber.slice(-4)}
*Amount:* ${amount} ${asset}
*Payout:* NGN ${payout}
*Reference ID:* ${referenceId}
*Transaction Hash:* \`${transactionHash}\`

*Network:* ${network}
`;

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminMessage, { parse_mode: 'Markdown' });

      // Store Transaction in Firebase
      await db.collection('transactions').add({
        userId,
        walletAddress,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: walletData.bank,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'Pending',
        network,
      });

      // Log Transaction Storage
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🗄 Transaction stored in Firebase for user ${userId}.`, { parse_mode: 'Markdown' });

      return res.status(200).send('OK');
    } else {
      // Handle other events if necessary
      return res.status(200).send('OK');
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${error.message}`);
  }
});

// Admin Upload Image Functionality
bot.on('photo', async (ctx) => {
  const adminId = ctx.from.id.toString();
  const userState = await getUserState(adminId);

  if (isAdmin(adminId) && userState.awaitingImage && userState.uploadImageTargetUserId) {
    const targetUserId = userState.uploadImageTargetUserId;
    const photo = ctx.message.photo.pop(); // Get the highest resolution photo
    const fileId = photo.file_id;

    try {
      await bot.telegram.sendPhoto(targetUserId, fileId, { caption: '*📷 Image from Admin*', parse_mode: 'Markdown' });
      await ctx.reply('✅ Image sent successfully.');
    } catch (error) {
      console.error('Error sending image to user:', error);
      await ctx.reply('⚠️ Failed to send image to the user.');
    }

    // Reset Admin State
    userState.uploadImageTargetUserId = null;
    userState.awaitingImage = false;
    await saveUserState(adminId, userState); // Save user state
  } else {
    // Handle photos from regular users or ignore
    return;
  }
});

// Admin Functions - Detailed Transaction Marked as Paid
// Handled in 'mark_paid' action above

// Handle Other Actions or Messages
// (No changes needed)

// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;

    if (event.event === 'deposit.success') {
      const walletAddress = event.data.address.address;
      const amount = event.data.amount;
      const asset = event.data.asset.symbol;
      const transactionHash = event.data.hash;
      const network = 'BNB Smart Chain'; // Adjust based on actual network

      // Find User by Wallet Address from 'wallets' collection
      const walletDoc = await db.collection('wallets').doc(walletAddress).get();

      if (!walletDoc.exists) {
        console.log(`No user found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      const walletData = walletDoc.data();
      const userId = walletData.userId;

      // Fetch user state
      const userState = await getUserState(userId);

      // Check if Wallet has Linked Bank
      if (!walletData.bank) {
        await bot.telegram.sendMessage(
          userId,
          `💰 *Deposit Received*: ${amount} ${asset}.\n\nPlease link a bank account to receive your payout securely.`,
          { parse_mode: 'Markdown' }
        );
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `⚠️ User ${userId} (${(await bot.telegram.getChat(userId)).username || 'No Username'}) has received a deposit but hasn't linked a bank account.`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, parseFloat(amount));
      const referenceId = generateReferenceId();

      // Notify User of Successful Deposit
      const formattedMessage = `
Hello ${walletData.bank.accountName},

A deposit of ${amount} ${asset} was received on your wallet address: \`${walletAddress}\`.

Your transaction is being processed. You’ll receive NGN ${payout} in your ${walletData.bank.bankName} account ending with ****${walletData.bank.accountNumber.slice(-4)} shortly.

We'll notify you once the process is complete.
`;

      await bot.telegram.sendMessage(userId, formattedMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });

      // Notify Admin with Transaction Details (Formatted)
      const userChat = await bot.telegram.getChat(userId);
      const username = userChat.username || 'No Username';

      const adminMessage = `
⚡️ *New Deposit Received*

*User ID:* ${userId}
*Username:* ${username}
*Bank Name:* ${walletData.bank.bankName}
*Account Number:* ****${walletData.bank.accountNumber.slice(-4)}
*Amount:* ${amount} ${asset}
*Payout:* NGN ${payout}
*Reference ID:* ${referenceId}
*Transaction Hash:* \`${transactionHash}\`

*Network:* ${network}
`;

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminMessage, { parse_mode: 'Markdown' });

      // Store Transaction in Firebase
      await db.collection('transactions').add({
        userId,
        walletAddress,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: walletData.bank,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'Pending',
        network,
      });

      // Log Transaction Storage
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🗄 Transaction stored in Firebase for user ${userId}.`, { parse_mode: 'Markdown' });

      return res.status(200).send('OK');
    } else {
      // Handle other events if necessary
      return res.status(200).send('OK');
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${error.message}`);
  }
});

// Start Express Server
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Webhook server running on port ${port}`);
});

// Launch Bot
bot.launch({
  dropPendingUpdates: true, // Optional: Drop pending updates on restart
})
  .then(() => console.log('DirectPay bot is live!'))
  .catch((err) => console.error('Error launching bot:', err));

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
