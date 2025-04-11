const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');

// Firebase Firestore (from bot.js)
const db = admin.firestore();

// Logger (corrected with 'new' for transports)
const logger = require('winston').createLogger({
  level: 'info',
  format: require('winston').format.combine(
    require('winston').format.timestamp(),
    require('winston').format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new (require('winston').transports.Console)(),
    new (require('winston').transports.File)({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }),
  ],
});

// getUserState (directly from bot.js)
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
        refundAddress: null,
        bankDetails: null,
      };
      await db.collection('users').doc(userId).set(defaultState);
      logger.info(`Initialized default user state for ${userId}`);
      return defaultState;
    }
    const data = userDoc.data();
    return {
      firstName: data.firstName || '',
      wallets: data.wallets || [],
      walletAddresses: data.walletAddresses || [],
      hasReceivedDeposit: data.hasReceivedDeposit || false,
      awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
      usePidgin: data.usePidgin || false,
      refundAddress: data.refundAddress || null,
      bankDetails: data.bankDetails || null,
    };
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    return {
      firstName: '',
      wallets: [],
      walletAddresses: [],
      hasReceivedDeposit: false,
      awaitingBroadcastMessage: false,
      usePidgin: false,
      refundAddress: null,
      bankDetails: null,
    };
  }
}

// Sell Scene
const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 1: Parse /sell command and validate token
  async (ctx) => {
    logger.info(`User ${ctx.from.id} entered sell_scene with message: ${ctx.message.text}`);
    if (!ctx.message || !ctx.message.text.startsWith('/sell')) {
      await ctx.reply('Use: /sell <amount> <contract_address> <network>');
      return ctx.scene.leave();
    }

    const [, amountStr, contractAddress, network] = ctx.message.text.split(' ');
    const amount = parseFloat(amountStr);
    if (!amount || isNaN(amount) || amount <= 0 || !contractAddress || !network) {
      await ctx.reply('Invalid format. Use: /sell <amount> <contract_address> <network> (e.g., /sell 10 0xA0b... Ethereum)');
      return ctx.scene.leave();
    }

    const chainIdMap = { Solana: 101, Ethereum: 1, Base: 8453 };
    const chainId = chainIdMap[network.charAt(0).toUpperCase() + network.slice(1).toLowerCase()];
    if (!chainId) {
      await ctx.reply('Unsupported network. Use: Solana, Ethereum, or Base.');
      return ctx.scene.leave();
    }

    // Validate token with Relay (no API key required)
    try {
      const response = await axios.post(
        'https://api.relay.link/currencies/v1',
        {
          chainIds: [chainId],
          address: contractAddress,
          defaultList: true,
          verified: true,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const currencies = response.data[0];
      if (!currencies || currencies.length === 0) {
        await ctx.reply('Token not found or unsupported on this network.');
        return ctx.scene.leave();
      }

      const token = currencies[0];
      ctx.wizard.state.data = {
        userId: ctx.from.id.toString(),
        amount: (amount * 10 ** token.decimals).toString(), // Amount in wei-like units
        asset: token.address,
        chainId,
        networkName: network.charAt(0).toUpperCase() + network.slice(1).toLowerCase(),
        decimals: token.decimals,
        symbol: token.symbol,
        tokenName: token.name,
      };

      const userState = await getUserState(ctx.wizard.state.data.userId);
      const msg = userState.usePidgin
        ? `Step 1/3: You wan sell ${amount} ${token.symbol} (${network}). Correct?`
        : `Step 1/3: You want to sell ${amount} ${token.symbol} (${network}). Confirm?`;
      await ctx.reply(msg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_token')],
        [Markup.button.callback('❌ No', 'retry_token')],
      ]));
      return ctx.wizard.next();
    } catch (err) {
      logger.error(`Token validation error for user ${ctx.from.id}: ${err.message}`);
      await ctx.reply(`Error validating token: ${err.message}`);
      return ctx.scene.leave();
    }
  },
  // Step 2: Bank Selection
  async (ctx) => {
    logger.info(`User ${ctx.from?.id} reached step 2 of sell_scene, callbackQuery: ${JSON.stringify(ctx.callbackQuery)}`);
    if (!ctx.callbackQuery) {
      await ctx.reply('Please confirm the token.');
      return ctx.scene.leave();
    }

    const userId = ctx.wizard.state.data.userId;
    if (ctx.callbackQuery.data === 'retry_token') {
      await ctx.reply('Enter again: /sell <amount> <contract_address> <network>');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery.data !== 'confirm_token') {
      logger.warn(`Unexpected callback data in step 2 for user ${userId}: ${ctx.callbackQuery.data}`);
      await ctx.reply('Unexpected action. Please start over with /sell.');
      return ctx.scene.leave();
    }

    const userState = await getUserState(userId);
    const bankDetails = userState.bankDetails || null;
    const msg = userState.usePidgin
      ? 'Step 2/3: Use your linked bank or new one?'
      : 'Step 2/3: Use your linked bank or a new one?';
    const buttons = bankDetails
      ? [
          [Markup.button.callback(`Use ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}`, 'use_existing_bank')],
          [Markup.button.callback('Add New Bank', 'add_new_bank')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ]
      : [
          [Markup.button.callback('Add New Bank', 'add_new_bank')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ];

    try {
      await ctx.editMessageText(msg, { reply_markup: Markup.inlineKeyboard(buttons) });
      await ctx.answerCbQuery(); // Acknowledge the callback
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error editing message in step 2 for user ${userId}: ${error.message}`);
      await ctx.reply('Error proceeding. Please try again.');
      return ctx.scene.leave();
    }
  },
  // Step 3: Connect Wallet
  async (ctx) => {
    logger.info(`User ${ctx.from?.id} reached step 3 of sell_scene, callbackQuery: ${JSON.stringify(ctx.callbackQuery)}`);
    if (!ctx.callbackQuery) {
      await ctx.reply('Please select a bank option.');
      return ctx.scene.leave();
    }

    const userId = ctx.wizard.state.data.userId;
    const userState = await getUserState(userId);

    let bankDetails;
    if (ctx.callbackQuery.data === 'add_new_bank') {
      logger.info(`User ${userId} chose to add new bank`);
      return ctx.scene.enter('bank_linking_scene_temp', { fromSell: true, sellData: ctx.wizard.state.data });
    } else if (ctx.callbackQuery.data === 'use_existing_bank') {
      bankDetails = userState.bankDetails;
      logger.info(`User ${userId} chose existing bank: ${bankDetails.bankName}`);
    } else if (ctx.callbackQuery.data === 'cancel_sell') {
      await ctx.reply('Sell cancelled.');
      return ctx.scene.leave();
    } else {
      logger.warn(`Unexpected callback data in step 3 for user ${userId}: ${ctx.callbackQuery.data}`);
      await ctx.reply('Unexpected action. Please start over with /sell.');
      return ctx.scene.leave();
    }

    ctx.wizard.state.data.bankDetails = bankDetails;

    // Generate Blockradar wallet
    const blockradarAddress = await generateBlockradarAddress(bankDetails);
    ctx.wizard.state.data.blockradarAddress = blockradarAddress;

    // Store session in Firestore
    const referenceId = `${userId}-${Date.now()}`;
    await db.collection('sessions').doc(referenceId).set({
      userId,
      amount: ctx.wizard.state.data.amount,
      asset: ctx.wizard.state.data.asset,
      chainId: ctx.wizard.state.data.chainId,
      bankDetails,
      blockradarAddress,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      symbol: ctx.wizard.state.data.symbol,
      tokenName: ctx.wizard.state.data.tokenName,
      decimals: ctx.wizard.state.data.decimals,
      networkName: ctx.wizard.state.data.networkName,
    });

    const msg = userState.usePidgin
      ? 'Step 3/3: Connect your wallet to continue.'
      : 'Step 3/3: Connect your wallet to proceed.';
    try {
      await ctx.editMessageText(msg, {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${userId}&session=${referenceId}`)],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ]),
      });
      await ctx.answerCbQuery();
      logger.info(`User ${userId} reached wallet connect step with session ${referenceId}`);
      return ctx.scene.leave();
    } catch (error) {
      logger.error(`Error editing message in step 3 for user ${userId}: ${error.message}`);
      await ctx.reply('Error proceeding to wallet connect. Please try again.');
      return ctx.scene.leave();
    }
  }
);

// Handle bank linking return
sellScene.enter(async (ctx) => {
  if (ctx.scene.state.bankDetails && ctx.scene.state.fromSell) {
    logger.info(`User ${ctx.from.id} returned from bank_linking_scene_temp with bank details`);
    ctx.wizard.state.data = {
      userId: ctx.from.id.toString(),
      amount: ctx.scene.state.sellData.amount,
      asset: ctx.scene.state.sellData.asset,
      chainId: ctx.scene.state.sellData.chainId,
      networkName: ctx.scene.state.sellData.networkName,
      decimals: ctx.scene.state.sellData.decimals,
      symbol: ctx.scene.state.sellData.symbol,
      tokenName: ctx.scene.state.sellData.tokenName,
      bankDetails: ctx.scene.state.bankDetails,
    };

    const userState = await getUserState(ctx.wizard.state.data.userId);
    const blockradarAddress = await generateBlockradarAddress(ctx.wizard.state.data.bankDetails);
    ctx.wizard.state.data.blockradarAddress = blockradarAddress;

    const referenceId = `${ctx.wizard.state.data.userId}-${Date.now()}`;
    await db.collection('sessions').doc(referenceId).set({
      userId: ctx.wizard.state.data.userId,
      amount: ctx.wizard.state.data.amount,
      asset: ctx.wizard.state.data.asset,
      chainId: ctx.wizard.state.data.chainId,
      bankDetails: ctx.wizard.state.data.bankDetails,
      blockradarAddress,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      symbol: ctx.wizard.state.data.symbol,
      tokenName: ctx.wizard.state.data.tokenName,
      decimals: ctx.wizard.state.data.decimals,
      networkName: ctx.wizard.state.data.networkName,
    });

    const msg = userState.usePidgin
      ? 'Step 3/3: Connect your wallet to continue.'
      : 'Step 3/3: Connect your wallet to proceed.';
    await ctx.reply(msg, Markup.inlineKeyboard([
      [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${ctx.wizard.state.data.userId}&session=${referenceId}`)],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')],
    ]));
    logger.info(`User ${ctx.from.id} redirected to wallet connect after bank linking with session ${referenceId}`);
    return ctx.scene.leave();
  }
});

// Actions
sellScene.action('confirm_token', async (ctx) => {
  logger.info(`User ${ctx.from.id} clicked confirm_token`);
  await ctx.answerCbQuery(); // Acknowledge the callback
  return ctx.wizard.next();
});

sellScene.action('retry_token', async (ctx) => {
  logger.info(`User ${ctx.from.id} clicked retry_token`);
  await ctx.reply('Enter again: /sell <amount> <contract_address> <network>');
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

sellScene.action('cancel_sell', async (ctx) => {
  logger.info(`User ${ctx.from.id} clicked cancel_sell`);
  await ctx.reply('Sell cancelled.');
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

sellScene.action('use_existing_bank', async (ctx) => {
  logger.info(`User ${ctx.from.id} clicked use_existing_bank`);
  await ctx.answerCbQuery();
  return ctx.wizard.next();
});

sellScene.action('add_new_bank', async (ctx) => {
  logger.info(`User ${ctx.from.id} clicked add_new_bank`);
  await ctx.answerCbQuery();
  return ctx.scene.enter('bank_linking_scene_temp', { fromSell: true, sellData: ctx.wizard.state.data });
});

// Blockradar wallet generation (adapted from bot.js generateWallet)
async function generateBlockradarAddress(bankDetails) {
  try {
    const chain = 'Base'; // Default to Base for Blockradar
    const chainData = {
      id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
      key: process.env.BLOCKRADAR_BASE_API_KEY,
      apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
      supportedAssets: ['USDC', 'USDT'],
      network: 'Base',
      chainId: 8453,
    };

    const response = await axios.post(
      chainData.apiUrl,
      { name: `DirectPay_Sell_Wallet_${bankDetails.accountNumber.slice(-4)}` },
      { headers: { 'x-api-key': chainData.key } }
    );

    const walletAddress = response.data.data.address;
    if (!walletAddress) throw new Error('Wallet address not returned from Blockradar.');
    logger.info(`Generated Blockradar wallet for bank ${bankDetails.bankName}: ${walletAddress}`);
    return walletAddress;
  } catch (error) {
    logger.error(`Error generating Blockradar wallet: ${error.message}`);
    return '0xGeneratedBlockradarAddress'; // Fallback dummy address
  }
}

// Export with setup function to integrate with bot.js
module.exports = {
  sellScene,
  setup: (bot, dbInstance, loggerInstance, getUserStateFunc) => {
    // No additional handlers needed; all are within the scene or reused from bot.js
  },
};
