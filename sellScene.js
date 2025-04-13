const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const ethers = require('ethers');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');

const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour

const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 1: Parse and Validate Input
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id');
      await ctx.replyWithMarkdown(
        '❌ Unable to process request. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || {};
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await getUserStateWithRetry(userId);
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const input = ctx.message?.text?.replace('/sell', '').trim().split(/\s+/);
    sellScene.logger.info(`User ${userId} entered sell scene with input: ${ctx.message?.text || 'unknown'}`);

    if (!input || input.length < 2) {
      const errorMsg = userState.usePidgin
        ? '❌ Format no correct. Use: /sell <amount> <asset> [chain]\nE.g., /sell 2 USDC eth'
        : '❌ Invalid format. Use: /sell <amount> <asset> [chain]\nE.g., /sell 2 USDC eth';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }

    const [amountStr, assetInput, chain = 'eth'] = input;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      const errorMsg = userState.usePidgin
        ? '❌ Amount no valid. Enter number like 2 or 0.5.'
        : '❌ Invalid amount. Enter a number like 2 or 0.5.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }

    ctx.wizard.state = {
      userId,
      amount,
      assetInput,
      chain: chain.toLowerCase(),
      stepStartedAt: Date.now(),
    };

    const msg = await ctx.replyWithMarkdown(userState.usePidgin ? '🔄 Dey check asset...' : '🔄 Verifying asset...');

    try {
      const chainId = mapChainToId(ctx.wizard.state.chain);
      if (!chainId) {
        throw new Error(`Unsupported chain: ${ctx.wizard.state.chain}. Try: eth, base, bnb, polygon`);
      }

      const normalizedInput = ethers.utils.isAddress(assetInput)
        ? ethers.utils.getAddress(assetInput)
        : assetInput.toLowerCase();
      const cacheKey = `asset:${chainId}:${normalizedInput}`;
      let assets = cache.get(cacheKey);
      if (!assets) {
        assets = ethers.utils.isAddress(assetInput)
          ? await validateAssetByAddress(assetInput, chainId)
          : await validateAssetByTerm(assetInput, chainId);
        assets = Array.isArray(assets) && Array.isArray(assets[0]) ? assets.flat() : assets;
        cache.set(cacheKey, assets);
      }

      if (!assets || assets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No asset match input. Check symbol or address.'
          : '❌ No matching assets found. Verify symbol or address.';
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          msg.message_id,
          null,
          errorMsg,
          Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
        );
        return ctx.scene.leave();
      }

      ctx.wizard.state.validatedAssets = assets;
      if (assets.length === 1) {
        ctx.wizard.state.selectedAsset = assets[0];
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          msg.message_id,
          null,
          userState.usePidgin
            ? `✅ Asset: *${assets[0].symbol}* on ${ctx.wizard.state.chain}`
            : `✅ Asset: *${assets[0].symbol}* on ${ctx.wizard.state.chain}`,
          { parse_mode: 'Markdown' },
        );
        if (!assets[0].metadata.verified) {
          await ctx.replyWithMarkdown(
            userState.usePidgin
              ? `⚠ *${assets[0].symbol}* no verified on ${ctx.wizard.state.chain}. E fit get risk. Continue? (Step 1/4)`
              : `⚠ *${assets[0].symbol}* is unverified on ${ctx.wizard.state.chain}. May be risky. Proceed? (Step 1/4)`,
            Markup.inlineKeyboard([
              [Markup.button.callback('✅ Yes', 'confirm_unverified')],
              [Markup.button.callback('❌ Cancel', 'cancel_sell')],
            ]),
          );
          return ctx.wizard.next();
        }
        return ctx.wizard.selectStep(2);
      }

      const options = assets.map((asset, index) => [
        Markup.button.callback(
          `${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...)${asset.metadata.verified ? '' : ' (Unverified)'}`,
          `select_asset_${index}`,
        ),
      ]);
      options.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        null,
        userState.usePidgin ? '🤔 Multiple assets dey. Pick one (Step 1/4):' : '🤔 Multiple assets found. Select one (Step 1/4):',
        Markup.inlineKeyboard(options),
      );
      return ctx.wizard.next();
    } catch (error) {
      sellScene.logger.error(`Error validating asset for ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? `❌ Error: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).`
        : `❌ Error: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).`;
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        null,
        errorMsg,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }
  },
  // Step 2: Select Asset or Confirm Unverified
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in step 2');
      await ctx.replyWithMarkdown(
        '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || {};
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await getUserStateWithRetry(userId);
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    if (Date.now() - ctx.wizard.state.stepStartedAt > INACTIVITY_TIMEOUT) {
      const errorMsg = userState.usePidgin
        ? '⏰ You don wait too long. Start again with /sell.'
        : '⏰ Inactive too long. Start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }

    return; // Handled by actions
  },
  // Step 3: Bank Selection
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in step 3');
      await ctx.replyWithMarkdown(
        '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || {};
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await getUserStateWithRetry(userId);
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const walletsWithBank = userState.wallets.filter((w) => w.bank);
    sellScene.logger.info(`User ${userId} in bank selection. Wallets with bank: ${walletsWithBank.length}`);

    if (!ctx.wizard.state.selectedAsset) {
      const errorMsg = userState.usePidgin
        ? '❌ No asset selected. Start again with /sell.'
        : '❌ No asset selected. Start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }

    const asset = ctx.wizard.state.selectedAsset;
    let amountInWei;
    try {
      amountInWei = ethers.utils.parseUnits(ctx.wizard.state.amount.toString(), asset.decimals).toString();
    } catch (error) {
      sellScene.logger.error(`Error parsing amount for ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Amount no valid for asset. Start again.'
        : '❌ Invalid amount for asset. Start over.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }

    ctx.wizard.state.amountInWei = amountInWei;
    ctx.wizard.state.stepStartedAt = Date.now();

    const assetMsg = userState.usePidgin
      ? `✅ *Asset Confirmed* (Step 2/4)\n\n*Symbol:* ${asset.symbol}\n*Name:* ${asset.name}\n*Address:* \`${asset.address}\`\n*Chain:* ${ctx.wizard.state.chain}\n*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n${asset.metadata.verified ? '' : '*Note:* Unverified asset.\n\n'}Where you want funds go?`
      : `✅ *Asset Confirmed* (Step 2/4)\n\n*Symbol:* ${asset.symbol}\n*Name:* ${asset.name}\n*Address:* \`${asset.address}\`\n*Chain:* ${ctx.wizard.state.chain}\n*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n${asset.metadata.verified ? '' : '*Note:* Unverified asset.\n\n'}Where would you like funds sent?`;

    if (walletsWithBank.length === 0) {
      await ctx.replyWithMarkdown(
        userState.usePidgin ? '🏦 No bank linked. Link one now? (Step 2/4)' : '🏦 No bank linked. Link one? (Step 2/4)',
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes', 'link_temp_bank')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ]),
      );
      return ctx.wizard.next();
    }

    const bankOptions = walletsWithBank.map((wallet, index) => [
      Markup.button.callback(
        `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})`,
        `select_bank_${index}`,
      ),
    ]);
    bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);
    bankOptions.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);
    await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
    return ctx.wizard.next();
  },
  // Step 4: Confirm Bank Selection
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in step 4');
      await ctx.replyWithMarkdown(
        '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || {};
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await getUserStateWithRetry(userId);
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    if (!ctx.wizard.state.bankDetails || !ctx.wizard.state.selectedWalletAddress) {
      const errorMsg = userState.usePidgin
        ? '❌ No bank selected. Go back or start again.'
        : '❌ No bank selected. Go back or start over.';
      await ctx.replyWithMarkdown(
        errorMsg,
        Markup.inlineKeyboard([
          [Markup.button.callback('⬅ Back', 'back_to_bank')],
          [Markup.button.callback('🔄 Retry', 'retry_sell')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ]),
      );
      return;
    }

    if (Date.now() - ctx.wizard.state.stepStartedAt > INACTIVITY_TIMEOUT) {
      const errorMsg = userState.usePidgin
        ? '⏰ You don wait too long. Start again with /sell.'
        : '⏰ Inactive too long. Start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }

    return; // Handled by actions
  },
  // Step 5: Prompt Wallet Connection
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in step 5');
      await ctx.replyWithMarkdown(
        '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || {};
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await getUserStateWithRetry(userId);
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const { selectedAsset: asset, bankDetails, selectedWalletAddress, amountInWei } = ctx.wizard.state;
    sellScene.logger.info(`User ${userId} in step 5: wallet connection`);

    if (!asset || !bankDetails || !selectedWalletAddress || !amountInWei) {
      const errorMsg = userState.usePidgin
        ? '❌ Something miss for sell. Start again.'
        : '❌ Missing sell details. Start over.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }

    ctx.wizard.state.sessionId = uuidv4();
    ctx.wizard.state.stepStartedAt = Date.now();

    const confirmMsg = userState.usePidgin
      ? `📝 *Sell Details* (Step 3/4)\n\n*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n*Chain:* ${ctx.wizard.state.chain}\n*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n${asset.metadata.verified ? '' : '*Note:* Unverified asset.\n\n'}Ready to connect wallet?`
      : `📝 *Sell Details* (Step 3/4)\n\n*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n*Chain:* ${ctx.wizard.state.chain}\n*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n${asset.metadata.verified ? '' : '*Note:* Unverified asset.\n\n'}Ready to connect wallet?`;
    await ctx.replyWithMarkdown(confirmMsg);

    const sessionData = {
      userId,
      amountInWei,
      token: asset.address,
      chainId: asset.chainId,
      bankDetails,
      blockradarWallet: selectedWalletAddress,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      isVerifiedAsset: asset.metadata.verified,
    };

    sellScene.logger.info(`Storing session for ${userId}, sessionId: ${ctx.wizard.state.sessionId}`);
    try {
      await retry(() => sellScene.db.collection('sessions').doc(ctx.wizard.state.sessionId).set(sessionData));
      sellScene.logger.info(`Stored session for ${userId}`);

      setTimeout(async () => {
        const sessionDoc = await sellScene.db.collection('sessions').doc(ctx.wizard.state.sessionId).get();
        if (sessionDoc.exists && sessionDoc.data().status === 'pending') {
          await ctx.replyWithMarkdown(
            userState.usePidgin
              ? '⚠ Session go expire in 1 minute! Connect wallet now.'
              : '⚠ Session expires in 1 minute! Connect wallet now.',
          );
        }
      }, 14 * 60 * 1000);
    } catch (error) {
      sellScene.logger.error(`Failed to store session for ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error saving sell. Try again or contact [@maxcswap](https://t.me/maxcswap).'
        : '❌ Error saving sell. Try again or contact [@maxcswap](https://t.me/maxcswap).';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }

    const connectUrl = `${sellScene.webhookDomain}/connect?sessionId=${ctx.wizard.state.sessionId}`;
    sellScene.logger.info(`Wallet URL for ${userId}: ${connectUrl}`);

    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? `✅ *Sell Ready!* (Step 4/4)\nConnect wallet in 15 mins:\n[${connectUrl}](${connectUrl})`
        : `✅ *Sell Ready!* (Step 4/4)\nConnect wallet within 15 minutes:\n[${connectUrl}](${connectUrl})`,
      Markup.inlineKeyboard([
        [Markup.button.url('Connect Wallet', connectUrl)],
        [Markup.button.callback('⬅ Back', 'back_to_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]),
    );

    return ctx.wizard.next();
  },
  // Step 6: Wait for Wallet Connection
  async (ctx) => {
    if (!sellScene.logger || !sellScene.db || !sellScene.getUserState) {
      console.error('Sell scene not initialized');
      await ctx.replyWithMarkdown('❌ Bot not initialized. Try again later.');
      return ctx.scene.leave();
    }

    if (!ctx.from || !ctx.from.id) {
      sellScene.logger.error('Missing ctx.from or ctx.from.id in step 6');
      await ctx.replyWithMarkdown(
        '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const userId = ctx.from.id.toString();
    ctx.wizard.state = ctx.wizard.state || {};
    ctx.wizard.state.userId = userId;
    let userState;
    try {
      userState = await getUserStateWithRetry(userId);
    } catch (error) {
      sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
      );
      return ctx.scene.leave();
    }

    const sessionId = ctx.wizard.state.sessionId;
    sellScene.logger.info(`User ${userId} in step 6: waiting for wallet, sessionId: ${sessionId}`);

    if (!sessionId) {
      const errorMsg = userState.usePidgin
        ? '❌ No session found. Start again with /sell.'
        : '❌ No session found. Start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }

    try {
      const sessionDoc = await retry(() => sellScene.db.collection('sessions').doc(sessionId).get());
      if (!sessionDoc.exists) {
        sellScene.logger.error(`Session ${sessionId} not found for ${userId}`);
        const errorMsg = userState.usePidgin
          ? '❌ Session gone. Start again with /sell.'
          : '❌ Session not found. Start over with /sell.';
        await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
        return ctx.scene.leave();
      }

      const session = sessionDoc.data();
      const now = new Date();
      if (new Date(session.expiresAt) < now) {
        sellScene.logger.info(`Session ${sessionId} expired for ${userId}`);
        await retry(() => sellScene.db.collection('sessions').doc(sessionId).update({ status: 'expired' }));
        const errorMsg = userState.usePidgin
          ? '⏰ Sell timeout. Start again with /sell.'
          : '⏰ Sell timed out. Start over with /sell.';
        await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
        return ctx.scene.leave();
      }

      if (session.status === 'completed') {
        await ctx.replyWithMarkdown(
          userState.usePidgin ? '✅ Sell done! Check bank.' : '✅ Sell completed! Check bank for payout.',
          Markup.inlineKeyboard([[Markup.button.callback('🔄 Sell Again', 'retry_sell')]]),
        );
        return ctx.scene.leave();
      }

      await ctx.replyWithMarkdown(
        userState.usePidgin
          ? '⏳ Dey wait for wallet connect... (Step 4/4)\nConnect quick!'
          : '⏳ Waiting for wallet connection... (Step 4/4)\nConnect promptly!',
        Markup.inlineKeyboard([
          [Markup.button.callback('⬅ Back', 'back_to_bank')],
          [Markup.button.callback('❌ Cancel', 'cancel_sell')],
        ]),
      );
    } catch (error) {
      sellScene.logger.error(`Error checking session for ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error checking sell. Try again or contact [@maxcswap](https://t.me/maxcswap).'
        : '❌ Error checking sell. Try again or contact [@maxcswap](https://t.me/maxcswap).';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]));
      return ctx.scene.leave();
    }
  },
);

// Middleware
sellScene.use((ctx, next) => {
  if (ctx.from && ctx.from.id) {
    ctx.wizard.state = ctx.wizard.state || {};
    ctx.wizard.state.userId = ctx.wizard.state.userId || ctx.from.id.toString();
    sellScene.logger?.debug(`Ensured userId ${ctx.wizard.state.userId}`);
  } else {
    sellScene.logger?.warn('Missing ctx.from') || console.warn('Missing ctx.from');
  }
  return next();
});

// Helper Functions
function mapChainToId(chain) {
  const chainMap = {
    eth: 1,
    ethereum: 1,
    base: 8453,
    bnb: 56,
    bsc: 56,
    polygon: 137,
    matic: 137,
  };
  return chainMap[chain.toLowerCase()];
}

async function validateAssetByAddress(address, chainId) {
  try {
    sellScene.logger.info(`Validating address: ${address} on chainId: ${chainId}`);
    const response = await retry(() =>
      axios.post(
        'https://api.relay.link/currencies/v1',
        {
          chainIds: [chainId],
          term: address,
          verified: false,
          limit: 10,
          includeAllChains: false,
          useExternalSearch: true,
          depositAddressOnly: true,
        },
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    sellScene.logger.info(`Relay.link response for address ${address}: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    sellScene.logger.error(`Address validation failed for ${address}: ${error.message}`);
    return [];
  }
}

async function validateAssetByTerm(term, chainId) {
  try {
    sellScene.logger.info(`Validating term: ${term} on chainId: ${chainId}`);
    const response = await retry(() =>
      axios.post(
        'https://api.relay.link/currencies/v1',
        {
          chainIds: [chainId],
          term,
          verified: false,
          limit: 10,
          includeAllChains: false,
          useExternalSearch: true,
          depositAddressOnly: true,
        },
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    sellScene.logger.info(`Relay.link response for term ${term}: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    sellScene.logger.error(`Term validation failed for ${term}: ${error.message}`);
    return [];
  }
}

async function getUserStateWithRetry(userId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await sellScene.getUserState(userId);
    } catch (error) {
      sellScene.logger?.warn(`Retry ${i + 1}/${retries} for getUserState: ${error.message}`);
      if (i === retries - 1) {
        sellScene.logger?.error(`Failed getUserState for ${userId}: ${error.message}`);
        return { usePidgin: false, wallets: [] };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function retry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Actions
sellScene.action(/select_asset_(\d+)/, async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    sellScene.logger.error('Missing userId in select_asset');
    await ctx.replyWithMarkdown(
      '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.wizard.state = ctx.wizard.state || {};
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await getUserStateWithRetry(userId);
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const index = parseInt(ctx.match[1], 10);
  const assets = ctx.wizard.state.validatedAssets;
  sellScene.logger.info(`User ${userId} selected asset index ${index}`);

  if (!assets || index < 0 || index >= assets.length) {
    await ctx.replyWithMarkdown(
      userState.usePidgin ? '❌ Asset no valid. Pick again.' : '❌ Invalid asset. Try again.',
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅ Back', 'back_to_asset')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]),
    );
    await ctx.answerCbQuery();
    return;
  }

  ctx.wizard.state.selectedAsset = assets[index];
  ctx.wizard.state.stepStartedAt = Date.now();
  await ctx.deleteMessage();
  await ctx.answerCbQuery();

  if (!assets[index].metadata.verified) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? `⚠ *${assets[index].symbol}* no verified on ${ctx.wizard.state.chain}. E fit get risk. Continue? (Step 1/4)`
        : `⚠ *${assets[index].symbol}* is unverified on ${ctx.wizard.state.chain}. May be risky. Proceed? (Step 1/4)`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_unverified')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]),
    );
    return;
  }

  return ctx.wizard.selectStep(2);
});

sellScene.action('confirm_unverified', async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    sellScene.logger.error('Missing userId in confirm_unverified');
    await ctx.replyWithMarkdown(
      '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.wizard.state = ctx.wizard.state || {};
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await getUserStateWithRetry(userId);
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  sellScene.logger.info(`User ${userId} confirmed unverified asset`);
  ctx.wizard.state.stepStartedAt = Date.now();
  await ctx.deleteMessage();
  await ctx.answerCbQuery();
  return ctx.wizard.selectStep(2);
});

sellScene.action(/select_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    sellScene.logger.error('Missing userId in select_bank');
    await ctx.replyWithMarkdown(
      '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.wizard.state = ctx.wizard.state || {};
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await getUserStateWithRetry(userId);
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const index = parseInt(ctx.match[1], 10);
  const walletsWithBank = userState.wallets.filter((w) => w.bank);
  sellScene.logger.info(`User ${userId} selected bank index ${index}`);

  if (index < 0 || index >= walletsWithBank.length) {
    await ctx.replyWithMarkdown(
      userState.usePidgin ? '❌ Bank no valid. Pick again.' : '❌ Invalid bank. Try again.',
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅ Back', 'back_to_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ]),
    );
    await ctx.answerCbQuery();
    return;
  }

  ctx.wizard.state.bankDetails = walletsWithBank[index].bank;
  ctx.wizard.state.selectedWalletAddress = walletsWithBank[index].address;
  ctx.wizard.state.stepStartedAt = Date.now();

  const confirmMsg = userState.usePidgin
    ? `🏦 Funds go to:\n*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\nE correct? (Step 3/4)`
    : `🏦 Funds will be sent to:\n*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\nIs this correct? (Step 3/4)`;
  await ctx.replyWithMarkdown(
    confirmMsg,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes', 'confirm_bank')],
      [Markup.button.callback('⬅ Back', 'back_to_bank')],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')],
    ]),
  );
  await ctx.answerCbQuery();
});

sellScene.action('confirm_bank', async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    sellScene.logger.error('Missing userId in confirm_bank');
    await ctx.replyWithMarkdown(
      '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.wizard.state = ctx.wizard.state || {};
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await getUserStateWithRetry(userId);
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  sellScene.logger.info(`User ${userId} confirmed bank`);
  ctx.wizard.state.stepStartedAt = Date.now();
  await ctx.deleteMessage();
  await ctx.answerCbQuery();
  return ctx.wizard.selectStep(4);
});

sellScene.action('link_temp_bank', async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    sellScene.logger.error('Missing userId in link_temp_bank');
    await ctx.replyWithMarkdown(
      '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.wizard.state = ctx.wizard.state || {};
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await getUserStateWithRetry(userId);
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  sellScene.logger.info(`User ${userId} linking temporary bank`);
  if (!ctx.scene.session.__scenes?.bank_linking_scene_temp) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ Bank linking no dey work now. Try again.'
        : '❌ Bank linking unavailable. Try again.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return;
  }
  ctx.wizard.state.awaitingTempBank = true;
  await ctx.scene.enter('bank_linking_scene_temp');
  await ctx.answerCbQuery();
});

sellScene.action('back_to_asset', async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    sellScene.logger.error('Missing userId in back_to_asset');
    await ctx.replyWithMarkdown(
      '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.wizard.state = ctx.wizard.state || {};
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await getUserStateWithRetry(userId);
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const assets = ctx.wizard.state.validatedAssets;
  sellScene.logger.info(`User ${userId} returned to asset selection`);

  if (!assets || assets.length === 0) {
    await ctx.replyWithMarkdown(
      userState.usePidgin ? '❌ No assets. Start again with /sell.' : '❌ No assets. Start over with /sell.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const options = assets.map((asset, index) => [
    Markup.button.callback(
      `${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...)${asset.metadata.verified ? '' : ' (Unverified)'}`,
      `select_asset_${index}`,
    ),
  ]);
  options.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);
  await ctx.replyWithMarkdown(
    userState.usePidgin ? '🤔 Pick asset (Step 1/4):' : '🤔 Select asset (Step 1/4):',
    Markup.inlineKeyboard(options),
  );
  ctx.wizard.state.stepStartedAt = Date.now();
  await ctx.answerCbQuery();
  return ctx.wizard.selectStep(1);
});

sellScene.action('back_to_bank', async (ctx) => {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    sellScene.logger.error('Missing userId in back_to_bank');
    await ctx.replyWithMarkdown(
      '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.wizard.state = ctx.wizard.state || {};
  ctx.wizard.state.userId = userId;
  let userState;
  try {
    userState = await getUserStateWithRetry(userId);
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error accessing account. Try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const walletsWithBank = userState.wallets.filter((w) => w.bank);
  sellScene.logger.info(`User ${userId} returned to bank selection`);

  if (!ctx.wizard.state.selectedAsset) {
    await ctx.replyWithMarkdown(
      userState.usePidgin ? '❌ No asset selected. Start again.' : '❌ No asset selected. Start over.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const asset = ctx.wizard.state.selectedAsset;
  const bankOptions = walletsWithBank.map((wallet, index) => [
    Markup.button.callback(
      `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})`,
      `select_bank_${index}`,
    ),
  ]);
  bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);
  bankOptions.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);

  const assetMsg = userState.usePidgin
    ? `✅ *Asset Confirmed* (Step 2/4)\n\n*Symbol:* ${asset.symbol}\n*Name:* ${asset.name}\n*Address:* \`${asset.address}\`\n*Chain:* ${ctx.wizard.state.chain}\n*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n${asset.metadata.verified ? '' : '*Note:* Unverified asset.\n\n'}Where you want funds go?`
    : `✅ *Asset Confirmed* (Step 2/4)\n\n*Symbol:* ${asset.symbol}\n*Name:* ${asset.name}\n*Address:* \`${asset.address}\`\n*Chain:* ${ctx.wizard.state.chain}\n*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n${asset.metadata.verified ? '' : '*Note:* Unverified asset.\n\n'}Where would you like funds sent?`;
  await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
  ctx.wizard.state.stepStartedAt = Date.now();
  await ctx.answerCbQuery();
  return ctx.wizard.selectStep(2);
});

sellScene.action('retry_sell', async (ctx) => {
  const userId = ctx.from?.id?.toString() || 'unknown';
  sellScene.logger.info(`User ${userId} retrying sell`);
  await ctx.answerCbQuery();
  await ctx.scene.enter('sell_scene');
});

sellScene.action('cancel_sell', async (ctx) => {
  const userId = ctx.from?.id?.toString() || 'unknown';
  let userState;
  try {
    userState = await getUserStateWithRetry(userId);
  } catch (error) {
    sellScene.logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    userState = { usePidgin: false };
  }

  sellScene.logger.info(`User ${userId} cancelled sell`);
  await ctx.replyWithMarkdown(
    userState.usePidgin ? '❌ Sell cancelled. Start again with /sell.' : '❌ Sell cancelled. Start over with /sell.',
    Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
  );
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

// Setup Function
function setup(bot, db, logger, getUserState, updateUserState, relayClient, privyClient, exchangeRates, chains, webhookDomain) {
  sellScene.getUserState = getUserState;
  sellScene.db = db;
  sellScene.logger = logger;
  sellScene.relayClient = relayClient;
  sellScene.privyClient = privyClient;
  sellScene.exchangeRates = exchangeRates;
  sellScene.chains = chains;
  sellScene.webhookDomain = webhookDomain || process.env.WEBHOOK_DOMAIN;

  bot.on('callback_query', async (ctx) => {
    if (ctx.scene.current?.id === 'bank_linking_scene_temp' && ctx.wizard.state.awaitingTempBank) {
      if (ctx.callbackQuery.data === 'sell_confirm_bank_temp') {
        const userId = ctx.from?.id?.toString();
        if (!userId) {
          sellScene.logger.error('Missing userId in bank_linking_scene_temp');
          await ctx.replyWithMarkdown(
            '❌ Unable to process. Try again or contact [@maxcswap](https://t.me/maxcswap).',
            Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]]),
          );
          await ctx.answerCbQuery();
          return;
        }
        sellScene.logger.info(`User ${userId} confirmed temporary bank`);
        ctx.wizard.state = ctx.wizard.state || {};
        ctx.wizard.state.bankDetails = ctx.scene.state.bankDetails;
        ctx.wizard.state.selectedWalletAddress = ctx.scene.state.walletAddress || ctx.wizard.state.selectedWalletAddress;
        ctx.wizard.state.stepStartedAt = Date.now();
        await ctx.answerCbQuery();
        await ctx.wizard.selectStep(3);
      }
    }
  });
}

module.exports = { sellScene, setup };
