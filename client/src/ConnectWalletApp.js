import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { createClient, getClient } from '@reservoir0x/relay-sdk';
import { adaptEthersSigner } from '@reservoir0x/relay-ethers-wallet-adapter';
import { ethers } from 'ethers';
import axios from 'axios';
import { toast, ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './ConnectWalletApp.css';

// Supported chains configuration
const SUPPORTED_CHAINS = {
  1: {
    name: 'Ethereum',
    chainId: 1,
    rpcUrl: `https://mainnet.infura.io/v3/${process.env.REACT_APP_INFURA_PROJECT_ID}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorer: 'https://etherscan.io',
  },
  8453: {
    name: 'Base',
    chainId: 8453,
    rpcUrl: `https://base-mainnet.infura.io/v3/${process.env.REACT_APP_INFURA_PROJECT_ID}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorer: 'https://basescan.org',
  },
  56: {
    name: 'BNB Chain',
    chainId: 56,
    rpcUrl: 'https://bsc-dataseed.binance.org/',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    blockExplorer: 'https://bscscan.com',
  },
  137: {
    name: 'Polygon',
    chainId: 137,
    rpcUrl: `https://polygon-mainnet.infura.io/v3/${process.env.REACT_APP_INFURA_PROJECT_ID}`,
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    blockExplorer: 'https://polygonscan.com',
  },
};

const ConnectWalletApp = () => {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [session, setSession] = useState(null);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('idle');
  const [tokenInfo, setTokenInfo] = useState({ symbol: 'Token', decimals: 18 });
  const location = useLocation();

  useEffect(() => {
    createClient({
      baseApiUrl: 'https://api.relay.link',
      source: 'directpay-app',
    });
  }, []);

  useEffect(() => {
    const fetchSession = async (retryCount = 3, delay = 1000) => {
      const urlParams = new URLSearchParams(location.search);
      const sessionId = urlParams.get('sessionId');
      if (!sessionId) {
        setError('Missing sessionId in URL. Please return to Telegram and try again.');
        toast.error('Missing sessionId. Please return to Telegram.');
        return;
      }

      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          console.log(`Attempt ${attempt}: Fetching session from /api/session?sessionId=${sessionId}`);
          const response = await axios.get(`/api/session?sessionId=${sessionId}`);
          console.log('Session response:', response.data);

          const requiredFields = ['amountInWei', 'token', 'chainId', 'bankDetails', 'blockradarWallet'];
          const missingFields = requiredFields.filter(field => !(field in response.data));
          if (missingFields.length > 0) {
            throw new Error(`Invalid session data: Missing fields - ${missingFields.join(', ')}`);
          }

          const bankRequiredFields = ['bankName', 'accountNumber', 'accountName'];
          const missingBankFields = bankRequiredFields.filter(field => !(field in response.data.bankDetails));
          if (missingBankFields.length > 0) {
            throw new Error(`Invalid bank details: Missing fields - ${missingBankFields.join(', ')}`);
          }

          if (!SUPPORTED_CHAINS[response.data.chainId]) {
            throw new Error(`Unsupported chain ID: ${response.data.chainId}`);
          }

          setSession(response.data);
          setError(null);

          // Fetch token metadata using Infura
          if (response.data.token !== '0x0000000000000000000000000000000000000000') {
            try {
              const chainConfig = SUPPORTED_CHAINS[response.data.chainId];
              const provider = new ethers.providers.JsonRpcProvider(chainConfig.rpcUrl);
              const tokenContract = new ethers.Contract(
                response.data.token,
                [
                  'function symbol() view returns (string)',
                  'function decimals() view returns (uint8)',
                ],
                provider
              );
              const [symbol, decimals] = await Promise.all([
                tokenContract.symbol(),
                tokenContract.decimals(),
              ]);
              setTokenInfo({ symbol, decimals });
            } catch (err) {
              console.error('Failed to fetch token metadata:', err);
              setTokenInfo({ symbol: 'Token', decimals: 18 });
              toast.warn('Could not fetch token details. Using default values.');
            }
          } else {
            const chainConfig = SUPPORTED_CHAINS[response.data.chainId];
            setTokenInfo({
              symbol: chainConfig.nativeCurrency.symbol,
              decimals: chainConfig.nativeCurrency.decimals,
            });
          }

          break;
        } catch (err) {
          console.error(`Attempt ${attempt} failed:`, err);
          if (attempt === retryCount) {
            setError(`Failed to fetch session: ${err.message}. Please try again or contact support.`);
            toast.error('Failed to fetch session. Please try again.');
          } else {
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
    };

    if (ready && authenticated) {
      fetchSession();
    }
  }, [ready, authenticated, location.search]);

  const switchChain = async (chainId, retryCount = 2) => {
    if (!SUPPORTED_CHAINS[chainId]) {
      throw new Error(`Unsupported chain ID: ${chainId}`);
    }

    let attempt = 0;
    while (attempt <= retryCount) {
      try {
        const provider = new ethers.providers.Web3Provider(window.ethereum);
        const currentChainId = (await provider.getNetwork()).chainId;
        const chainConfig = SUPPORTED_CHAINS[chainId];

        if (currentChainId !== chainId) {
          setStatus(`Switching to ${chainConfig.name}...`);
          toast.info(`Please switch to ${chainConfig.name} in your wallet.`);
          try {
            await window.ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: `0x${chainId.toString(16)}` }],
            });
          } catch (switchError) {
            if (switchError.code === 4902) {
              await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [
                  {
                    chainId: `0x${chainId.toString(16)}`,
                    chainName: chainConfig.name,
                    rpcUrls: [chainConfig.rpcUrl],
                    nativeCurrency: chainConfig.nativeCurrency,
                    blockExplorerUrls: [chainConfig.blockExplorer],
                  },
                ],
              });
            } else {
              throw switchError;
            }
          }
          console.log(`Switched to chain ID ${chainId}`);
          setStatus(`Connected to ${chainConfig.name}`);
        }
        return;
      } catch (err) {
        attempt++;
        if (attempt > retryCount) {
          setError(`Failed to switch to chain ID ${chainId}: ${err.message}`);
          setStatus('error');
          toast.error(`Failed to switch chains. Please try again.`);
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  };

  const fetchQuote = async (adaptedWallet) => {
    if (!session) return;
    setLoading(true);
    setStatus('Fetching quote...');
    try {
      console.log(`Fetching quote for wallet ${wallets[0].address}, session:`, session);
      const quote = await getClient().actions.getQuote({
        chainId: session.chainId,
        toChainId: 8453,
        currency: session.token,
        toCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        tradeType: 'EXACT_INPUT',
        amount: session.amountInWei,
        wallet: adaptedWallet,
        recipient: session.blockradarWallet,
      });
      console.log('Quote response:', quote);
      setQuote(quote);
      setError(null);
      toast.success('Quote fetched successfully!');
    } catch (err) {
      setError(`Failed to fetch quote: ${err.message}`);
      setStatus('error');
      toast.error('Failed to fetch quote. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSell = async () => {
    if (!wallets.length || !session || !quote) return;

    const wallet = wallets[0];
    const provider = await wallet.getEthersProvider();
    const signer = provider.getSigner();
    const adaptedWallet = adaptEthersSigner(signer);

    setLoading(true);
    setStatus('Initiating transaction...');

    try {
      // Ensure wallet is on the origin chain
      await switchChain(session.chainId);

      let txHash = null;
      let approvalCompleted = false;
      let signatureCompleted = false;

      await getClient().actions.execute({
        quote,
        wallet: adaptedWallet,
        depositGasLimit: '500000', // Reasonable limit for deposits
        onProgress: async (progress) => {
          console.log('Transaction progress:', progress);

          const { currentStep, currentStepItem, txHashes, error, refunded } = progress;

          // Handle errors
          if (error || currentStep?.error || currentStepItem?.error) {
            const errorMsg =
              error?.message ||
              currentStep?.error ||
              currentStepItem?.error ||
              'Unknown error';
            throw new Error(errorMsg);
          }

          if (refunded) {
            throw new Error('Operation failed and was refunded.');
          }

          // Update status based on current step
          if (currentStep?.id === 'approve' && !approvalCompleted) {
            setStatus('Awaiting approval in your wallet...');
            if (currentStepItem?.data) {
              currentStepItem.data.gas = '50000'; // Optimize approval gas
            }
          }

          if (
            currentStep?.id === 'approve' &&
            currentStepItem?.status === 'complete'
          ) {
            setStatus('Approval completed. Preparing next step...');
            toast.success('Token approval completed!');
            approvalCompleted = true;
          }

          if (currentStep?.id.includes('authorize') && !signatureCompleted) {
            setStatus('Awaiting signature in your wallet...');
            if (currentStep.kind === 'signature' && currentStepItem?.data?.sign) {
              toast.info('Please sign the authorization.');
            }
          }

          if (
            currentStep?.id.includes('authorize') &&
            currentStepItem?.status === 'complete'
          ) {
            setStatus('Signature completed. Proceeding to deposit...');
            toast.success('Authorization signed!');
            signatureCompleted = true;
          }

          if (
            currentStep?.id === 'deposit' &&
            (approvalCompleted || signatureCompleted)
          ) {
            await switchChain(session.chainId); // Ensure still on origin chain
            setStatus('Depositing funds to relayer...');
            toast.info('Please confirm the deposit transaction.');
          }

          if (txHashes && txHashes.length > 0) {
            txHash = txHashes[txHashes.length - 1].txHash;
            const isBatch = txHashes[txHashes.length - 1].isBatchTx || false;
            setStatus(
              `Transaction ${isBatch ? 'batch ' : ''}submitted: ${txHash.slice(0, 6)}...`
            );
            toast.success(
              `Transaction ${isBatch ? 'batch ' : ''}submitted: ${txHash.slice(0, 6)}...`
            );
            setStatus('Awaiting relayer confirmation...');
          }

          // Update UI with progress details
          if (progress.details) {
            console.log('Quote details:', progress.details);
          }
        },
      });

      if (txHash) {
        try {
          await axios.post('/webhook/sell-completed', {
            sessionId: new URLSearchParams(location.search).get('sessionId'),
            txHash,
          });
          setStatus('Sell completed successfully!');
          toast.success('Sell completed! Funds will be sent to your bank.');
        } catch (webhookErr) {
          console.error('Webhook error:', webhookErr);
          setError(`Sell completed, but failed to notify server: ${webhookErr.message}`);
          toast.warn('Sell completed, but server notification failed. Contact support.');
        }
      } else {
        throw new Error('No transaction hash received. Please try again.');
      }
    } catch (err) {
      console.error('Sell error:', err);
      let errorMsg = err.message;
      if (err.name === 'DepositTransactionTimeoutError') {
        errorMsg = `Deposit transaction ${err.txHash} is still pending. Please wait or check your wallet.`;
      } else if (err.name === 'TransactionConfirmationError') {
        errorMsg = `Transaction failed: ${err.message}. Receipt: ${JSON.stringify(err.receipt)}`;
      }
      setError(`Error during sell: ${errorMsg}`);
      setStatus('error');
      toast.error(`Sell failed: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (wallets.length > 0 && session && !quote && ready && authenticated) {
      (async () => {
        try {
          const provider = await wallets[0].getEthersProvider();
          const signer = await provider.getSigner();
          const adaptedWallet = adaptEthersSigner(signer);
          await fetchQuote(adaptedWallet);
        } catch (err) {
          setError(`Failed to initialize wallet for quote: ${err.message}`);
          setStatus('error');
          toast.error('Failed to initialize wallet. Please reconnect.');
        }
      })();
    }
  }, [wallets, session, ready, authenticated]);

  // Format USD values to 2 decimal places
  const formatUSD = (value) => {
    if (!value) return '0.00';
    return parseFloat(value).toFixed(2);
  };

  // Format token amounts based on decimals
  const formatTokenAmount = (amount, decimals) => {
    try {
      return ethers.utils.formatUnits(amount, decimals);
    } catch {
      return amount;
    }
  };

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-4">DirectPay Wallet Connector</h1>
        <ToastContainer position="top-right" autoClose={5000} />
        {!authenticated ? (
          <button
            onClick={login}
            className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition"
            aria-label="Connect Wallet"
          >
            Connect Wallet
          </button>
        ) : (
          <>
            <div className="mb-4">
              <p className="text-sm text-gray-600">
                <span className="font-semibold">Connected:</span>{' '}
                {wallets[0]?.address.slice(0, 6)}...{wallets[0]?.address.slice(-4)}
              </p>
              <p className="text-sm text-gray-600">
                <span className="font-semibold">Status:</span> {status}
              </p>
            </div>
            {session ? (
              <div className="space-y-3">
                <p className="text-sm">
                  <span className="font-semibold">Amount:</span>{' '}
                  {formatTokenAmount(session.amountInWei, tokenInfo.decimals)} {tokenInfo.symbol}
                </p>
                <p className="text-sm">
                  <span className="font-semibold">Chain:</span>{' '}
                  {SUPPORTED_CHAINS[session.chainId]?.name || 'Unknown'}
                </p>
                <p className="text-sm">
                  <span className="font-semibold">To:</span>{' '}
                  {session.blockradarWallet.slice(0, 6)}...{session.blockradarWallet.slice(-4)}
                </p>
                {quote ? (
                  <>
                    <div className="border-t pt-2">
                      <p className="text-sm font-semibold">Quote Details:</p>
                      <p className="text-sm">
                        <span className="font-semibold">Input:</span>{' '}
                        {formatTokenAmount(
                          quote.details?.currencyIn?.amount,
                          quote.details?.currencyIn?.currency?.decimals || 18
                        )}{' '}
                        {quote.details?.currencyIn?.currency?.symbol || 'Unknown'} (~$
                        {formatUSD(quote.details?.currencyIn?.amountUsd)})
                      </p>
                      <p className="text-sm">
                        <span className="font-semibold">Output:</span>{' '}
                        {formatTokenAmount(
                          quote.details?.currencyOut?.amount,
                          quote.details?.currencyOut?.currency?.decimals || 6
                        )}{' '}
                        {quote.details?.currencyOut?.currency?.symbol || 'USDC'} (~$
                        {formatUSD(quote.details?.currencyOut?.amountUsd)})
                      </p>
                      <p className="text-sm">
                        <span className="font-semibold">Gas Fee:</span>{' '}
                        {formatTokenAmount(
                          quote.fees?.gas?.amount,
                          quote.fees?.gas?.currency?.decimals || 18
                        )}{' '}
                        {quote.fees?.gas?.currency?.symbol || 'ETH'} (~$
                        {formatUSD(quote.fees?.gas?.amountUsd)})
                      </p>
                      <p className="text-sm">
                        <span className="font-semibold">Relayer Fee:</span>{' '}
                        {formatTokenAmount(
                          quote.fees?.relayer?.amount,
                          quote.fees?.relayer?.currency?.decimals || 18
                        )}{' '}
                        {quote.fees?.relayer?.currency?.symbol || 'ETH'} (~$
                        {formatUSD(quote.fees?.relayer?.amountUsd)})
                      </p>
                      <p className="text-sm">
                        <span className="font-semibold">Swap Impact:</span>{' '}
                        {quote.details?.swapImpact?.percent}% (~$
                        {formatUSD(quote.details?.swapImpact?.usd)})
                      </p>
                      <p className="text-sm">
                        <span className="font-semibold">Slippage Tolerance:</span>{' '}
                        {quote.details?.slippageTolerance?.destination?.percent || '0'}%
                      </p>
                    </div>
                    <button
                      onClick={handleSell}
                      disabled={loading}
                      className={`w-full py-2 rounded-lg transition ${
                        loading
                          ? 'bg-gray-400 cursor-not-allowed'
                          : 'bg-green-600 text-white hover:bg-green-700'
                      }`}
                      aria-label="Execute Sell"
                    >
                      {loading ? (
                        <span className="flex items-center justify-center">
                          <svg
                            className="animate-spin h-5 w-5 mr-2 text-white"
                            viewBox="0 0 24 24"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8v8H4z"
                            />
                          </svg>
                          Processing...
                        </span>
                      ) : (
                        'Execute Sell'
                      )}
                    </button>
                  </>
                ) : (
                  <p className="text-sm text-gray-500">
                    {loading ? 'Fetching quote...' : 'Waiting for quote...'}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-500">Fetching session...</p>
            )}
            <button
              onClick={logout}
              className="w-full mt-4 bg-red-600 text-white py-2 rounded-lg hover:bg-red-700 transition"
              aria-label="Disconnect Wallet"
            >
              Disconnect
            </button>
          </>
        )}
        {error && (
          <div className="mt-4 p-3 bg-red-100 text-red-700 rounded-lg" role="alert">
            {error}
            {error.includes('Missing sessionId') && (
              <p>
                <a
                  href="https://t.me/yourBotUsername"
                  className="underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Return to Telegram
                </a>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const App = () => (
  <PrivyProvider
    appId={process.env.REACT_APP_PRIVY_APP_ID}
    config={{
      fetch: (url, options) => {
        if (url.includes('auth.privy.io/api/v1/analytics_events')) {
          return fetch(url, { ...options, mode: 'no-cors' });
        }
        return fetch(url, options);
      },
    }}
  >
    <ConnectWalletApp />
  </PrivyProvider>
);

export default App;
