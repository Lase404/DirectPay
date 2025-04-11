const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const ethers = require('ethers');

const chainNameToId = {
  eth: 1, ethereum: 1, polygon: 137, bnb: 56, base: 8453, // Add more as needed
};

const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 0: Parse input and validate with Relay.link
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await ctx.getUserState(userId);
    const args = ctx.message.text.split(' ').slice(1); // Remove /sell
    if (args.length !== 3) {
      const errorMsg = userState.usePidgin
        ? '❌ Use: /sell <amount> <term/address> <chain> (e.g., /sell 100 USDC eth)'
        : '❌ Usage: /sell <amount> <term/address> <chain> (e.g., /sell 100 USDC eth)';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    const [amountStr, termOrAddress, chainInput] = args;
    const amount = parseFloat(amountStr);
    const chainId = chainNameToId[chainInput.toLowerCase()] || parseInt(chainInput, 10);
    if (isNaN(amount) || amount <= 0 || isNaN(chainId)) {
      const errorMsg = userState.usePidgin
        ? '❌ Amount or chain no correct. Try again.'
        : '❌ Invalid amount or chain. Please try again.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    ctx.wizard.state.sellData = { amount, chainId, userId };
    const isAddress = ethers.utils.isAddress(termOrAddress);
    let response;

    try {
      const config = {
        method: 'post',
        url: 'https://api.relay.link/currencies/v1',
        headers: { 'Content-Type': 'application/json' },
        data: {
          chainIds: [chainId],
          verified: true,
          limit: 10,
          includeAllChains: false,
          useExternalSearch: true,
          depositAddressOnly: false,
          ...(isAddress ? { address: termOrAddress } : { term: termOrAddress }),
        },
      };
      response = await axios(config);
      const assets = response.data[0] || [];
      if (!assets.length) {
        const errorMsg = userState.usePidgin
          ? `❌ No asset found for "${termOrAddress}" on chain ${chainId}. Try again.`
          : `❌ No asset found for "${termOrAddress}" on chain ${chainId}. Please try again.`;
        await ctx.replyWithMarkdown(errorMsg);
        return ctx.scene.leave();
      }

      ctx.wizard.state.sellData.assets = assets;
      ctx.wizard.state.sellData.selectedAsset = assets[0]; // Default to first
      const linkedBank = userState.wallets.find(w => w.bank)?.bank;

      if (assets.length === 1 && linkedBank) {
        const confirmMsg = userState.usePidgin
          ? `✅ *Sell Details*\n\n` +
            `• *Asset:* ${assets[0].symbol} (${assets[0].name}) - \`${assets[0].address.slice(0, 6)}...\` (Chain ${chainId})\n` +
            `• *Amount:* ${amount}\n` +
            `• *Bank:* ${linkedBank.bankName} (****${linkedBank.accountNumber.slice(-4)}) - ${linkedBank.accountName}\n\n` +
            `Everything correct?`
          : `✅ *Sell Details*\n\n` +
            `• *Asset:* ${assets[0].symbol} (${assets[0].name}) - \`${assets[0].address.slice(0, 6)}...\` (Chain ${chainId})\n` +
            `• *Amount:* ${amount}\n` +
            `• *Bank:* ${linkedBank.bankName} (****${linkedBank.accountNumber.slice(-4)}) - ${linkedBank.accountName}\n\n` +
            `Everything correct?`;
        await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
          [Markup.button.callback('✅ Proceed', 'proceed')],
          [Markup.button.callback('❌ Edit', 'edit')],
        ]));
        return ctx.wizard.next();
      }

      let options = assets.map((asset, idx) => [
        Markup.button.callback(
          `${asset.symbol} (${asset.name}) - ${asset.address.slice(0, 6)}...`,
          `select_asset_${idx}`
        ),
      ]);
      const prompt = userState.usePidgin
        ? '📜 *Multiple Assets Found*\n\nPick the one you wan sell:'
        : '📜 *Multiple Assets Found*\n\nSelect the asset you want to sell:';
      await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(options));
      return ctx.wizard.next();
    } catch (error) {
      ctx.logger.error(`Error validating asset for ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Error checking asset. Try again later.');
      return ctx.scene.leave();
    }
  },
  // Step 1: Handle asset selection or proceed
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    const userId = ctx.wizard.state.sellData.userId;
    const userState = await ctx.getUserState(userId);

    if (ctx.callbackQuery.data === 'edit') {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ Okay, enter /sell again with correct details.'
        : '❌ Okay, please run /sell again with the correct details.');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery.data === 'proceed') {
      return ctx.wizard.next();
    }

    const idx = parseInt(ctx.callbackQuery.data.split('_')[2], 10);
    ctx.wizard.state.sellData.selectedAsset = ctx.wizard.state.sellData.assets[idx];
    const linkedBank = userState.wallets.find(w => w.bank)?.bank;

    const confirmMsg = userState.usePidgin
      ? `✅ *Sell Details*\n\n` +
        `• *Asset:* ${ctx.wizard.state.sellData.selectedAsset.symbol} (${ctx.wizard.state.sellData.selectedAsset.name}) - \`${ctx.wizard.state.sellData.selectedAsset.address.slice(0, 6)}...\` (Chain ${ctx.wizard.state.sellData.chainId})\n` +
        `• *Amount:* ${ctx.wizard.state.sellData.amount}\n` +
        `• *Bank:* ${linkedBank.bankName} (****${linkedBank.accountNumber.slice(-4)}) - ${linkedBank.accountName}\n\n` +
        `Everything correct?`
      : `✅ *Sell Details*\n\n` +
        `• *Asset:* ${ctx.wizard.state.sellData.selectedAsset.symbol} (${ctx.wizard.state.sellData.selectedAsset.name}) - \`${ctx.wizard.state.sellData.selectedAsset.address.slice(0, 6)}...\` (Chain ${ctx.wizard.state.sellData.chainId})\n` +
        `• *Amount:* ${ctx.wizard.state.sellData.amount}\n` +
        `• *Bank:* ${linkedBank.bankName} (****${linkedBank.accountNumber.slice(-4)}) - ${linkedBank.accountName}\n\n` +
        `Everything correct?`;
    await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Proceed', 'proceed')],
      [Markup.button.callback('❌ Edit', 'edit')],
      [Markup.button.callback('🏦 Change Bank', 'link_temp_bank')],
    ]));
    return ctx.wizard.next();
  },
  // Step 2: Connect wallet
  async (ctx) => {
    const userId = ctx.wizard.state.sellData.userId;
    const userState = await ctx.getUserState(userId);

    if (ctx.callbackQuery?.data === 'link_temp_bank') {
      await ctx.scene.enter('bank_linking_scene_temp');
      ctx.wizard.state.awaitingTempBank = true;
      return;
    }

    if (ctx.wizard.state.awaitingTempBank && ctx.scene.state.bankDetails) {
      ctx.wizard.state.sellData.bankDetails = ctx.scene.state.bankDetails;
      delete ctx.wizard.state.awaitingTempBank;
    } else {
      ctx.wizard.state.sellData.bankDetails = userState.wallets.find(w => w.bank)?.bank;
    }

    const connectMsg = userState.usePidgin
      ? '🔗 *Connect Your Wallet*\n\nClick below to connect your wallet via Privy:\n\n⏳ Waiting for wallet connection...'
      : '🔗 *Connect Your Wallet*\n\nClick below to connect your wallet via Privy:\n\n⏳ Waiting for wallet connection...';
    const waitingMsg = await ctx.replyWithMarkdown(connectMsg, Markup.inlineKeyboard([
      [Markup.button.url('Connect Wallet', `${ctx.webhookDomain}/connect-wallet?userId=${userId}`)],
    ]));

    ctx.wizard.state.awaitingWallet = true;
    setTimeout(async () => {
      if (ctx.wizard.state.awaitingWallet) {
        await ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, null,
          userState.usePidgin
            ? '❌ Wallet connection don timeout. Try again with /sell.'
            : '❌ Wallet connection timed out. Try again with /sell.',
          { parse_mode: 'Markdown' }
        );
        ctx.scene.leave();
      }
    }, 120000); // 2 minutes
    return ctx.wizard.next();
  },
  // Step 3: Fetch quote and execute
  async (ctx) => {
    const userId = ctx.wizard.state.sellData.userId;
    const userState = await ctx.getUserState(userId);

    if (!ctx.wizard.state.sellData.userAddress) {
      return; // Wait for webhook
    }

    const { amount, chainId, selectedAsset, userAddress, bankDetails } = ctx.wizard.state.sellData;
    const amountInWei = ethers.utils.parseUnits(amount.toString(), selectedAsset.decimals).toString();
    const isNative = selectedAsset.metadata.isNative;
    const originCurrency = isNative ? '0x0000000000000000000000000000000000000000' : selectedAsset.address;

    try {
      const quoteResponse = await axios.post(
        'https://api.relay.link/quote',
        {
          user: userAddress,
          originChainId: chainId,
          originCurrency,
          destinationChainId: 8453, // Base chain
          destinationCurrency: ctx.blockradarUsdcAddress,
          tradeType: 'EXACT_INPUT',
          recipient: ctx.blockradarUsdcAddress,
          amount: amountInWei,
          refundTo: userAddress,
        },
        { headers: { 'Content-Type': 'application/json' } }
      );

      const quote = quoteResponse.data[0];
      ctx.wizard.state.sellData.quote = quote;

      // Calculate detailed quote info
      const amountIn = parseFloat(ethers.utils.formatUnits(amountInWei, selectedAsset.decimals));
      const amountOut = parseFloat(ethers.utils.formatUnits(quote.destination.amount, 6)); // USDC has 6 decimals
      const feeAmount = parseFloat(quote.fee.amount); // Assuming fee is in origin currency units
      const feeCurrency = quote.fee.currency === originCurrency ? selectedAsset.symbol : 'USDC';

      // Assume 1:1 USD value for simplicity (fetch real prices via API like CoinGecko if needed)
      const amountInUSD = amountIn * (selectedAsset.symbol === 'USDC' ? 1 : ctx.exchangeRates[selectedAsset.symbol] || 1);
      const amountOutUSD = amountOut; // USDC on Base is 1:1 with USD
      const feeUSD = feeAmount * (feeCurrency === 'USDC' ? 1 : ctx.exchangeRates[feeCurrency] || 1);

      // Slippage: Difference between expected and actual output (simplified)
      const expectedOutUSD = amountInUSD - feeUSD; // Without slippage
      const slippageUSD = expectedOutUSD - amountOutUSD;
      const slippagePercent = (slippageUSD / expectedOutUSD * 100).toFixed(2);

      // Naira payout using server's exchange rate
      const nairaPayout = (amountOut * ctx.exchangeRates.USDC).toFixed(2);

      const quoteMsg = userState.usePidgin
        ? `📊 *Sell Quote*\n\n` +
          `• *Amount In:* ${amountIn} ${selectedAsset.symbol} (~$${amountInUSD.toFixed(2)} USD)\n` +
          `• *Amount Out:* ${amountOut} USDC (~$${amountOutUSD.toFixed(2)} USD)\n` +
          `• *Naira Payout:* ₦${nairaPayout}\n` +
          `• *Fees:* ${feeAmount} ${feeCurrency} (~$${feeUSD.toFixed(2)} USD)\n` +
          `• *Slippage:* $${slippageUSD.toFixed(2)} (${slippagePercent}%)\n\n` +
          `Ready to approve and sell?`
        : `📊 *Sell Quote*\n\n` +
          `• *Amount In:* ${amountIn} ${selectedAsset.symbol} (~$${amountInUSD.toFixed(2)} USD)\n` +
          `• *Amount Out:* ${amountOut} USDC (~$${amountOutUSD.toFixed(2)} USD)\n` +
          `• *Naira Payout:* ₦${nairaPayout}\n` +
          `• *Fees:* ${feeAmount} ${feeCurrency} (~$${feeUSD.toFixed(2)} USD)\n` +
          `• *Slippage:* $${slippageUSD.toFixed(2)} (${slippagePercent}%)\n\n` +
          `Ready to approve and sell?`;
      await ctx.replyWithMarkdown(quoteMsg, Markup.inlineKeyboard([
        [Markup.button.url('Approve & Execute', `${ctx.webhookDomain}/execute?userId=${userId}&quoteId=${quote.id}`)],
      ]));
      return ctx.scene.leave();
    } catch (error) {
      ctx.logger.error(`Error fetching quote for ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? `❌ Wahala dey: ${error.response?.data?.message || error.message}\n\nTry again?`
        : `❌ Error: ${error.response?.data?.message || error.message}\n\nRetry?`;
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Retry', 'retry_quote')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]));
    }
  }
);

function setup(bot, app, db, logger, getUserState, privy, blockradarUsdcAddress, exchangeRates) {
  sellScene.getUserState = getUserState;
  sellScene.logger = logger;
  sellScene.webhookDomain = process.env.WEBHOOK_DOMAIN;
  sellScene.blockradarUsdcAddress = blockradarUsdcAddress;
  sellScene.exchangeRates = exchangeRates; // Pass exchangeRates from index.js

  sellScene.action(/select_asset_(\d+)/, async (ctx) => {
    ctx.wizard.selectStep(1);
    await sellScene.steps[1](ctx);
  });

  sellScene.action('proceed', async (ctx) => {
    ctx.wizard.selectStep(2);
    await sellScene.steps[2](ctx);
  });

  sellScene.action('link_temp_bank', async (ctx) => {
    ctx.wizard.selectStep(2);
    await sellScene.steps[2](ctx);
  });

  sellScene.action('retry_quote', async (ctx) => {
    ctx.wizard.selectStep(3);
    await sellScene.steps[3](ctx);
  });

  sellScene.action('cancel_sell', async (ctx) => ctx.scene.leave());

  // Webhook for wallet connection
  app.post('/webhook/wallet-connected', async (req, res) => {
    const { userId, walletAddress } = req.body;
    logger.info(`Wallet connected for user ${userId}: ${walletAddress}`);
    const userState = await getUserState(userId);
    await bot.telegram.sendMessage(userId,
      userState.usePidgin
        ? `✅ Wallet connected: \`${walletAddress}\`. We dey prepare your sell now...`
        : `✅ Wallet connected: \`${walletAddress}\`. Preparing your sell now...`,
      { parse_mode: 'Markdown' }
    );

    const session = bot.scene.session.__scenes[userId];
    if (session && session.current === 'sell_scene') {
      session.state.sellData.userAddress = walletAddress;
      await sellScene.steps[3]({ ...ctx, wizard: { state: session.state }, from: { id: userId } });
    }
    res.status(200).send('OK');
  });
}

module.exports = { sellScene, setup };
