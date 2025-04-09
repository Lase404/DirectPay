const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const { createClient } = require('@reservoir0x/relay-sdk');
const { v4: uuidv4 } = require('uuid');

// Relay SDK setup
const relayClient = createClient({ adapters: [] }); // Add adapters if needed (e.g., solanaAdapter)

// Supported networks mapping
const networkMap = {
  eth: 1,        // Ethereum Mainnet
  base: 8453,    // Base
  sol: 792703809, // Solana (Relay chain ID, adjust if needed)
  polygon: 137,  // Polygon
  bnb: 56        // BNB Smart Chain
};

const sellScene = new Scenes.WizardScene(
  'sell_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? 'Enter amount and asset (e.g., "10 USDC"):'
      : 'Enter the amount and asset (e.g., "10 USDC"):';
    await ctx.reply(prompt);
    ctx.wizard.state.data = { userId };
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userState = await getUserState(ctx.wizard.state.data.userId);
    const input = ctx.message.text.trim().split(' ');
    const amount = parseFloat(input[0]);
    const asset = input[1]?.toUpperCase() || 'USDC';

    if (isNaN(amount) || amount <= 0) {
      const errorMsg = userState.usePidgin
        ? 'Invalid amount o. Use "10 USDC" format:'
        : 'Invalid amount. Use format "10 USDC":';
      await ctx.reply(errorMsg);
      return ctx.wizard.selectStep(1);
    }

    ctx.wizard.state.data.amount = amount;
    ctx.wizard.state.data.asset = asset;
    const prompt = userState.usePidgin
      ? 'Enter network (e.g., "sol", "eth", "base"):'
      : 'Enter the network (e.g., "sol", "eth", "base"):';
    await ctx.reply(prompt);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const networkInput = ctx.message.text.trim().toLowerCase();
    const chainId = networkMap[networkInput];
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (!chainId) {
      const errorMsg = userState.usePidgin
        ? 'Invalid network o. Use "sol", "eth", "base", etc.:'
        : 'Invalid network. Use "sol", "eth", "base", etc.:';
      await ctx.reply(errorMsg);
      return ctx.wizard.selectStep(2);
    }

    const { userId, amount, asset } = ctx.wizard.state.data;
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    // Validate token with Relay
    const currencyRes = await axios.post('https://api.relay.link/currencies/v1', {
      defaultList: true,
      chainIds: [chainId],
      term: asset,
      verified: true,
      limit: 1
    }).catch(err => {
      logger.error(`Relay currency validation failed for ${asset} on ${networkInput}: ${err.message}`);
      throw err;
    });

    const token = currencyRes.data[0]?.[0];
    if (!token) {
      const errorMsg = userState.usePidgin
        ? `${asset} no dey on ${networkInput.toUpperCase()} o. Check am well.`
        : `${asset} not found on ${networkInput.toUpperCase()}. Please check your input.`;
      await ctx.reply(errorMsg);
      return ctx.scene.leave();
    }

    ctx.wizard.state.data.token = token;
    ctx.wizard.state.data.chainId = chainId;
    ctx.wizard.state.data.amountInWei = (BigInt(Math.floor(amount * Math.pow(10, token.decimals)))).toString();

    const linkedBank = userDoc.exists ? userDoc.data().linkedBank : null;
    if (!linkedBank) {
      const prompt = userState.usePidgin
        ? 'No bank dey o. We go link one now for this sell...'
        : 'No bank linked. Linking a bank account now for this sell...';
      await ctx.reply(prompt);
      return ctx.scene.enter('bank_linking_scene_temp');
    } else {
      ctx.wizard.state.data.bankDetails = linkedBank;
      const confirmMsg = userState.usePidgin
        ? `Sell ${amount} ${asset} on ${networkInput.toUpperCase()}.\nUsing bank: ${linkedBank.bankName} - ****${linkedBank.accountNumber.slice(-4)}\nGo ahead?`
        : `Sell ${amount} ${asset} on ${networkInput.toUpperCase()}.\nUsing bank: ${linkedBank.bankName} - ****${linkedBank.accountNumber.slice(-4)}\nProceed?`;
      await ctx.reply(confirmMsg, {
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('✅ Yes', 'proceed_sell'), Markup.button.callback('❌ No', 'cancel_sell')],
            [Markup.button.callback('🏦 Link New Bank', 'link_new_bank')]
          ]
        }
      });
      return ctx.wizard.next();
    }
  },
  async (ctx) => {
    const callbackData = ctx.callbackQuery?.data;
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (!callbackData) return;

    if (callbackData === 'cancel_sell') {
      const cancelMsg = userState.usePidgin
        ? 'Sell don cancel o.'
        : 'Sell cancelled.';
      await ctx.reply(cancelMsg);
      return ctx.scene.leave();
    } else if (callbackData === 'link_new_bank') {
      const prompt = userState.usePidgin
        ? 'Linking new bank for this sell...'
        : 'Linking a new bank for this sell...';
      await ctx.reply(prompt);
      return ctx.scene.enter('bank_linking_scene_temp');
    } else if (callbackData !== 'proceed_sell') {
      return; // Ignore other callbacks
    }

    const { userId, amount, asset, chainId, token, amountInWei } = ctx.wizard.state.data;
    const bankDetails = ctx.wizard.state.data.bankDetails;

    // Fetch Relay quote
    const quote = await relayClient.actions.getQuote({
      chainId, // Origin chain
      toChainId: 8453, // Base as destination
      amount: amountInWei,
      currency: token.address,
      toCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      recipient: bankDetails.relayAddress,
      tradeType: 'EXACT_INPUT'
    }).catch(err => {
      logger.error(`Failed to fetch Relay quote for user ${userId}: ${err.message}`);
      throw err;
    });

    const quoteMsg = userState.usePidgin
      ? `Quote:\nSell: ${quote.details.currencyIn.amountFormatted} ${token.symbol}\nReceive: ${quote.details.currencyOut.amountFormatted} USDC\nConfirm with wallet?`
      : `Quote:\nSell: ${quote.details.currencyIn.amountFormatted} ${token.symbol}\nReceive: ${quote.details.currencyOut.amountFormatted} USDC\nProceed with wallet connection?`;
    await ctx.reply(quoteMsg, {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.url('Connect Wallet', `${process.env.WEBAPP_URL}/connect?userId=${userId}&session=${Date.now()}`)],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')]
        ]
      }
    });

    // Store session data for frontend
    const referenceId = `SELL-${uuidv4().replace(/-/g, '')}`;
    await db.collection('sessions').doc(referenceId).set({
      userId,
      quote,
      walletAddress: bankDetails.relayAddress,
      chainId,
      amountInWei,
      token,
      bankDetails,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    ctx.wizard.state.data.referenceId = referenceId;
    return ctx.wizard.next();
  },
  async (ctx) => {
    const callbackData = ctx.callbackQuery?.data;
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (callbackData === 'cancel_sell') {
      const cancelMsg = userState.usePidgin
        ? 'Sell don cancel o.'
        : 'Sell cancelled.';
      await ctx.reply(cancelMsg);
      return ctx.scene.leave();
    }

    const waitingMsg = userState.usePidgin
      ? 'Waiting for wallet confirmation... Check your wallet app o.'
      : 'Waiting for wallet confirmation... Check your wallet app.';
    await ctx.reply(waitingMsg);
    return ctx.scene.leave();
  }
);

// Handle bank linking scene exit
sellScene.on('enter', async (ctx) => {
  if (ctx.scene.state.bankDetails) {
    ctx.wizard.state.data.bankDetails = ctx.scene.state.bankDetails;
    delete ctx.scene.state.bankDetails;
  }
});

module.exports = sellScene;
