import React, { useEffect, useState, Fragment } from 'react';
import { useLocation } from 'react-router-dom';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { createClient, getClient } from '@reservoir0x/relay-sdk';
import { adaptEthersSigner } from '@reservoir0x/relay-ethers-wallet-adapter';
import { ethers } from 'ethers';
import axios from 'axios';
import { toast, ToastContainer } from 'react-toastify';
import { FaCoins, FaGasPump, FaExchangeAlt, FaShieldAlt, FaClock, FaWallet, FaCheckCircle, FaPaperPlane, FaSpinner, FaCopy, FaExternalLinkAlt, FaChevronDown } from 'react-icons/fa';
import QRCode from 'react-qr-code';
import { Dialog, Transition } from '@headlessui/react';
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

// Utility Functions
const formatUSD = (value) => (!value ? '0.00' : parseFloat(value).toFixed(2));

const formatTokenAmount = (amount, decimals) => {
  try {
    return ethers.utils.formatUnits(amount, decimals);
  } catch {
    return amount;
  }
};

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
      }
      return;
    } catch (err) {
      attempt++;
      if (attempt > retryCount) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
};

const getTokenInfo = async (token, chainId) => {
  if (token === '0x0000000000000000000000000000000000000000') {
    const chainConfig = SUPPORTED_CHAINS[chainId];
    return {
      symbol: chainConfig.nativeCurrency.symbol,
      decimals: chainConfig.nativeCurrency.decimals,
    };
  }

  try {
    const chainConfig = SUPPORTED_CHAINS[chainId];
    const provider = new ethers.providers.JsonRpcProvider(chainConfig.rpcUrl);
    const tokenContract = new ethers.Contract(
      token,
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
    return { symbol, decimals };
  } catch (err) {
    console.error('Failed to fetch token metadata:', err);
    toast.warn('Could not fetch token details. Using default values.');
    return { symbol: 'Token', decimals: 18 };
  }
};

const fetchQuote = async (wallet, session, setQuote, setError, setLoading, setStatus) => {
  if (!session) return;
  setLoading(true);
  setStatus('Fetching quote...');
  try {
    const provider = await wallet.getEthersProvider();
    const signer = await provider.getSigner();
    const adaptedWallet = adaptEthersSigner(signer);
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
    setQuote(quote);
    setError(null);
    toast.success('Quote fetched successfully!');
  } catch (err) {
    setError(`Failed to fetch quote: ${err.message}`);
    setStatus('error');
    toast.error('Failed to fetch quote.');
  } finally {
    setLoading(false);
  }
};

const handleSell = async (wallet, session, quote, setLoading, setStatus, setTxHash, setError, location) => {
  if (!wallet || !session || !quote) return;

  const provider = await wallet.getEthersProvider();
  const signer = provider.getSigner();
  const adaptedWallet = adaptEthersSigner(signer);

  setLoading(true);
  setStatus('Initiating transaction...');

  try {
    await switchChain(session.chainId);
    let approvalCompleted = false;
    let signatureCompleted = false;

    await getClient().actions.execute({
      quote,
      wallet: adaptedWallet,
      depositGasLimit: '500000',
      onProgress: async (progress) => {
        const { currentStep, currentStepItem, txHashes, error, refunded } = progress;

        if (error || currentStep?.error || currentStepItem?.error) {
          throw new Error(error?.message || currentStep?.error || currentStepItem?.error || 'Unknown error');
        }

        if (refunded) {
          throw new Error('Operation failed and was refunded.');
        }

        if (currentStep?.id === 'approve' && !approvalCompleted) {
          setStatus('Awaiting approval in your wallet...');
          if (currentStepItem?.data) {
            currentStepItem.data.gas = '50000';
          }
        }

        if (currentStep?.id === 'approve' && currentStepItem?.status === 'complete') {
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

        if (currentStep?.id.includes('authorize') && currentStepItem?.status === 'complete') {
          setStatus('Signature completed. Proceeding to deposit...');
          toast.success('Authorization signed!');
          signatureCompleted = true;
        }

        if (currentStep?.id === 'deposit' && (approvalCompleted || signatureCompleted)) {
          await switchChain(session.chainId);
          setStatus('Depositing funds to relayer...');
          toast.info('Please confirm the deposit transaction.');
        }

        if (txHashes && txHashes.length > 0) {
          const txHash = txHashes[txHashes.length - 1].txHash;
          const isBatch = txHashes[txHashes.length - 1].isBatchTx || false;
          setTxHash(txHash);
          setStatus(`Transaction ${isBatch ? 'batch ' : ''}submitted: ${txHash.slice(0, 6)}...`);
          toast.success(`Transaction ${isBatch ? 'batch ' : ''}submitted: ${txHash.slice(0, 6)}...`);
          setStatus('Awaiting relayer confirmation...');
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
        setError(`Sell completed, but failed to notify server: ${webhookErr.message}`);
        toast.warn('Sell completed, but server notification failed. Contact support.');
      }
    } else {
      throw new Error('No transaction hash received.');
    }
  } catch (err) {
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

// Components
const TransactionTimeline = ({ status }) => {
  const steps = [
    { id: 'connect', label: 'Connect Wallet', icon: FaWallet },
    { id: 'approve', label: 'Approve Token', icon: FaCheckCircle },
    { id: 'deposit', label: 'Deposit Funds', icon: FaPaperPlane },
    { id: 'complete', label: 'Complete', icon: FaCheckCircle },
  ];

  const getStepStatus = (stepId) => {
    if (stepId === 'connect' && status !== 'idle') return 'completed';
    if (stepId === 'approve' && status.includes('approval')) return 'active';
    if (stepId === 'approve' && status.includes('completed')) return 'completed';
    if (stepId === 'deposit' && status.includes('Depositing')) return 'active';
    if (stepId === 'deposit' && status.includes('submitted')) return 'completed';
    if (stepId === 'complete' && status.includes('Sell completed')) return 'completed';
    return 'pending';
  };

  return (
    <div className="flex justify-between mb-6">
      {steps.map((step, index) => (
        <div key={step.id} className="flex flex-col items-center relative">
          <div
            className={`w-10 h-10 flex items-center justify-center rounded-full ${
              getStepStatus(step.id) === 'completed'
                ? 'bg-[var(--success)] text-white'
                : getStepStatus(step.id) === 'active'
                ? 'bg-[var(--primary)] text-white animate-pulse'
                : 'bg-gray-300 text-gray-600'
            }`}
            title={step.label}
          >
            <step.icon className="w-5 h-5" />
          </div>
          <span className="text-xs mt-2 text-gray-600">{step.label}</span>
          {index < steps.length - 1 && (
            <div className="absolute top-4 left-10 w-full h-1 bg-gray-200">
              <div
                className={`h-full ${
                  getStepStatus(steps[index + 1].id) !== 'pending' ? 'bg-[var(--success)]' : 'bg-gray-200'
                }`}
                style={{ width: 'calc(100% - 2.5rem)' }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const QuoteDisplay = ({ quote, tokenInfo }) => {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="card mb-4">
      <h3 className="text-lg font-semibold text-gray-800 mb-2">Transaction Summary</h3>
      <div className="space-y-2">
        <p className="flex items-center">
          <FaCoins className="w-4 h-4 mr-2 text-yellow-500" />
          <span>
            Input: {formatTokenAmount(quote.details?.currencyIn?.amount, tokenInfo.decimals)}{' '}
            {tokenInfo.symbol} (~${formatUSD(quote.details?.currencyIn?.amountUsd)})
          </span>
        </p>
        <p className="flex items-center">
          <FaCoins className="w-4 h-4 mr-2 text-green-500" />
          <span>
            Output: {formatTokenAmount(quote.details?.currencyOut?.amount, 6)} USDC (~${formatUSD(quote.details?.currencyOut?.amountUsd)})
          </span>
        </p>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-[var(--primary)] text-sm flex items-center"
        >
          {showDetails ? 'Hide Details' : 'Show Details'}
          <FaChevronDown className={`ml-1 transform ${showDetails ? 'rotate-180' : ''}`} />
        </button>
        {showDetails && (
          <div className="pl-4 space-y-2 animate-fade-in">
            <p className="flex items-center">
              <FaGasPump className="w-4 h-4 mr-2 text-gray-500" />
              Gas Fee: {formatTokenAmount(quote.fees?.gas?.amount, 18)} ETH (~${formatUSD(quote.fees?.gas?.amountUsd)})
            </p>
            <p className="flex items-center">
              <FaGasPump className="w-4 h-4 mr-2 text-gray-500" />
              Relayer Fee: {formatTokenAmount(quote.fees?.relayer?.amount, 18)} ETH (~${formatUSD(quote.fees?.relayer?.amountUsd)})
            </p>
            <p className="flex items-center">
              <FaExchangeAlt className="w-4 h-4 mr-2 text-red-500" />
              Swap Impact: {quote.details?.swapImpact?.percent}% (~${formatUSD(quote.details?.swapImpact?.usd)})
            </p>
            <p className="flex items-center">
              <FaShieldAlt className="w-4 h-4 mr-2 text-blue-500" />
              Slippage Tolerance: {quote.details?.slippageTolerance?.destination?.percent || '0'}%
            </p>
            <p className="flex items-center">
              <FaClock className="w-4 h-4 mr-2 text-gray-500" />
              Est. Time: ~{quote.breakdown?.[0]?.timeEstimate || 12} seconds
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

const TransactionStatus = ({ txHash, chainId, status }) => {
  const explorerUrl = SUPPORTED_CHAINS[chainId]?.blockExplorer || 'https://etherscan.io';
  const txLink = txHash ? `${explorerUrl}/tx/${txHash}` : '';

  const copyTxHash = () => {
    navigator.clipboard.write(txHash);
    toast.info('Transaction hash copied!');
  };

  return txHash ? (
    <div className="card mb-4">
      <h3 className="text-lg font-semibold text-gray-800 mb-2">Transaction Status</h3>
      <p className="text-sm flex items-center">
        <span className="font-semibold mr-1">Status:</span> {status}
      </p>
      <p className="text-sm flex items-center">
        <span className="font-semibold mr-1">Tx Hash:</span>
        <a href={txLink} target="_blank" rel="noopener noreferrer" className="text-[var(--primary)] truncate">
          {txHash.slice(0, 6)}...{txHash.slice(-4)}
          <FaExternalLinkAlt className="inline ml-1 w-3 h-3" />
        </a>
        <button onClick={copyTxHash} className="ml-2 text-gray-500 hover:text-gray-700">
          <FaCopy className="w-4 h-4" />
        </button>
      </p>
      <div className="mt-4 hidden sm:block">
        <QRCode value={txLink} size={100} />
      </div>
    </div>
  ) : null;
};

const ConfirmSellModal = ({ isOpen, onClose, onConfirm, quote, tokenInfo }) => {
  const totalFeesUsd =
    parseFloat(quote.fees?.gas?.amountUsd || 0) +
    parseFloat(quote.fees?.relayer?.amountUsd || 0);
  const inputUsd = parseFloat(quote.details?.currencyIn?.amountUsd || 0);
  const isHighFee = inputUsd > 0 && totalFeesUsd / inputUsd > 0.1;

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-10" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black bg-opacity-25" />
        </Transition.Child>
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="card max-w-md">
                <Dialog.Title className="text-lg font-semibold text-gray-800">
                  Confirm Sell
                </Dialog.Title>
                <div className="mt-2 space-y-2">
                  <p className="text-sm">
                    You’re selling{' '}
                    <strong>
                      {formatTokenAmount(quote.details?.currencyIn?.amount, tokenInfo.decimals)}{' '}
                      {tokenInfo.symbol}
                    </strong>{' '}
                    for{' '}
                    <strong>
                      {formatTokenAmount(quote.details?.currencyOut?.amount, 6)} USDC
                    </strong>
                    .
                  </p>
                  <p className="text-sm">
                    Total Fees: ~${formatUSD(totalFeesUsd)} (Gas: ${formatUSD(quote.fees?.gas?.amountUsd)}, Relayer: ${formatUSD(quote.fees?.relayer?.amountUsd)})
                  </p>
                  {isHighFee && (
                    <p className="text-sm text-[var(--error)]">
                      ⚠ High fees detected ({((totalFeesUsd / inputUsd) * 100).toFixed(1)}% of input).
                    </p>
                  )}
                </div>
                <div className="mt-4 flex justify-end space-x-2">
                  <button onClick={onClose} className="btn-secondary">
                    Cancel
                  </button>
                  <button onClick={onConfirm} className="btn-primary">
                    Confirm
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};

const HelpSection = () => (
  <div className="mt-4 text-center">
    <a
      href="https://t.me/maxcswap"
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--primary)] text-sm hover:underline"
    >
      Need help? Contact @maxcswap
    </a>
  </div>
);

// Main Component
const ConnectWalletApp = () => {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [session, setSession] = useState(null);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('idle');
  const [tokenInfo, setTokenInfo] = useState({ symbol: 'Token', decimals: 18 });
  const [txHash, setTxHash] = useState(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
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
        setError('Missing sessionId in URL.');
        toast.error('Missing sessionId.');
        return;
      }

      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          const response = await axios.get(`/api/session?sessionId=${sessionId}`);
          const { data } = response;

          const requiredFields = ['amountInWei', 'token', 'chainId', 'bankDetails', 'blockradarWallet'];
          const missingFields = requiredFields.filter(field => !(field in data));
          if (missingFields.length > 0) {
            throw new Error(`Missing fields: ${missingFields.join(', ')}`);
          }

          const bankRequiredFields = ['bankName', 'accountNumber', 'accountName'];
          const missingBankFields = bankRequiredFields.filter(field => !(field in data.bankDetails));
          if (missingBankFields.length > 0) {
            throw new Error(`Missing bank fields: ${missingBankFields.join(', ')}`);
          }

          if (!SUPPORTED_CHAINS[data.chainId]) {
            throw new Error(`Unsupported chain ID: ${data.chainId}`);
          }

          setSession(data);
          setError(null);
          setTokenInfo(await getTokenInfo(data.token, data.chainId));
          break;
        } catch (err) {
          if (attempt === retryCount) {
            setError(`Failed to fetch session: ${err.message}`);
            toast.error('Failed to fetch session.');
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    };

    if (ready && authenticated) {
      fetchSession();
    }
  }, [ready, authenticated, location.search]);

  useEffect(() => {
    if (wallets.length > 0 && session && !quote && ready && authenticated) {
      fetchQuote(wallets[0], session, setQuote, setError, setLoading, setStatus);
    }
  }, [wallets, session, ready, authenticated]);

  const handleSellClick = () => setIsConfirmOpen(true);

  const handleConfirmSell = () => {
    setIsConfirmOpen(false);
    handleSell(wallets[0], session, quote, setLoading, setStatus, setTxHash, setError, location);
  };

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[var(--primary)]"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--background)]">
      <div className="card w-full max-w-lg">
        <div className="flex items-center mb-4">
          <img src="/logo.png" alt="DirectPay Logo" className="h-8 mr-2" />
          <h1 className="text-2xl font-bold text-gray-800">DirectPay</h1>
        </div>
        <ToastContainer position="top-right" autoClose={5000} />
        {!authenticated ? (
          <button onClick={login} className="btn-primary w-full">
            Connect Wallet
          </button>
        ) : (
          <>
            <div className="card mb-4">
              <p className="text-sm text-gray-600">
                <span className="font-semibold">Connected:</span>{' '}
                {wallets[0]?.address.slice(0, 6)}...{wallets[0]?.address.slice(-4)}
              </p>
              <p className="text-sm text-gray-600">
                <span className="font-semibold">Status:</span> {status}
              </p>
            </div>
            {session ? (
              <>
                <TransactionTimeline status={status} />
                <div className="card mb-4">
                  <h3 className="text-lg font-semibold text-gray-800 mb-2">Sell Details</h3>
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
                </div>
                {quote ? (
                  <>
                    <QuoteDisplay quote={quote} tokenInfo={tokenInfo} />
                    {txHash && (
                      <TransactionStatus txHash={txHash} chainId={session.chainId} status={status} />
                    )}
                    <button
                      onClick={handleSellClick}
                      disabled={loading}
                      className={`btn-primary w-full ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      {loading ? (
                        <span className="flex items-center justify-center">
                          <FaSpinner className="animate-spin h-5 w-5 mr-2" />
                          Processing...
                        </span>
                      ) : (
                        'Execute Sell'
                      )}
                    </button>
                    <ConfirmSellModal
                      isOpen={isConfirmOpen}
                      onClose={() => setIsConfirmOpen(false)}
                      onConfirm={handleConfirmSell}
                      quote={quote}
                      tokenInfo={tokenInfo}
                    />
                  </>
                ) : (
                  <p className="text-sm text-gray-500">{loading ? 'Fetching quote...' : 'Waiting for quote...'}</p>
                )}
                <button onClick={logout} className="btn-secondary w-full mt-4">
                  Disconnect
                </button>
              </>
            ) : (
              <p className="text-sm text-gray-500">Fetching session...</p>
            )}
            {error && (
              <div className="mt-4 p-3 bg-red-100 text-red-700 rounded-lg">
                {error}
                <p className="mt-2 text-sm">
                  Try refreshing or{' '}
                  <a href="https://t.me/maxcswap" className="underline" target="_blank" rel="noopener noreferrer">
                    contact support
                  </a>
                  .
                </p>
              </div>
            )}
            <HelpSection />
          </>
        )}
      </div>
    </div>
  );
};

// App Wrapper
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
