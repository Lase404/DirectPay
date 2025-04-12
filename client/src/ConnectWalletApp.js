import React, { useEffect, useState, Fragment } from 'react';
import { useLocation } from 'react-router-dom';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { createClient, getClient } from '@reservoir0x/relay-sdk';
import { adaptEthersSigner } from '@reservoir0x/relay-ethers-wallet-adapter';
import { ethers } from 'ethers';
import axios from 'axios';
import { toast, ToastContainer } from 'react-toastify';
import { FaCoins, FaGasPump, FaExchangeAlt, FaShieldAlt, FaClock, FaWallet, FaCheckCircle, FaPaperPlane, FaCopy, FaExternalLinkAlt, FaChevronDown, FaExclamationTriangle, FaSpinner } from 'react-icons/fa';
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

const TransactionTimeline = ({ status, progress }) => {
  const steps = [
    { id: 'connect', label: 'Connect Wallet', icon: FaWallet },
    { id: 'approve', label: 'Approve Token', icon: FaCheckCircle },
    { id: 'deposit', label: 'Deposit Funds', icon: FaPaperPlane },
    { id: 'complete', label: 'Complete', icon: FaCheckCircle },
  ];

  const getStepStatus = (stepId) => {
    if (!status) return 'pending';
    if (stepId === 'connect' && status !== 'idle') return 'completed';
    if (stepId === 'approve' && status.includes('approval')) return 'active';
    if (stepId === 'approve' && status.includes('completed')) return 'completed';
    if (stepId === 'deposit' && status.includes('Depositing')) return 'active';
    if (stepId === 'deposit' && status.includes('submitted')) return 'completed';
    if (stepId === 'complete' && status.includes('Sell completed')) return 'completed';
    return 'pending';
  };

  return (
    <div className="card mb-6">
      <div className="flex justify-between">
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
      {progress > 0 && progress < 100 && (
        <div className="mt-4">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-sm text-gray-600 mt-1">Progress: {progress}%</p>
        </div>
      )}
    </div>
  );
};

const QuoteDisplay = ({ quote, tokenInfo, logoUri, isVerifiedAsset }) => {
  const [showDetails, setShowDetails] = useState(false);
  const formatUSD = (value) => {
    if (!value || isNaN(value)) return '0.00';
    return parseFloat(value).toFixed(2);
  };
  const formatTokenAmount = (amount, decimals) => {
    if (!amount || !decimals) return '0';
    try {
      return ethers.utils.formatUnits(amount, decimals);
    } catch {
      return amount.toString();
    }
  };

  if (!quote || !tokenInfo) return null;

  return (
    <div className="card mb-4">
      <h3 className="text-lg font-semibold text-gray-800 mb-2">Transaction Summary</h3>
      {!isVerifiedAsset && (
        <div className="alert-warning mb-4" role="alert">
          <FaExclamationTriangle className="w-5 h-5 mr-2" />
          <span>
            This asset ({tokenInfo.symbol || 'Unknown'}) is unverified. It may have low liquidity or risks. Proceed with caution.
          </span>
        </div>
      )}
      <div className="space-y-2">
        <p className="flex items-center">
          <img
            src={logoUri || 'https://via.placeholder.com/20'}
            alt={`${tokenInfo.symbol || 'Token'} logo`}
            className="w-5 h-5 mr-2 rounded-full"
            onError={(e) => (e.target.src = 'https://via.placeholder.com/20')}
          />
          <span>
            Input: {formatTokenAmount(quote.details?.currencyIn?.amount, tokenInfo.decimals)}{' '}
            {tokenInfo.symbol || 'Token'} (~${formatUSD(quote.details?.currencyIn?.amountUsd)})
          </span>
        </p>
        <p className="flex items-center">
          <FaCoins className="w-4 h-4 mr-2 text-green-500" />
          <span>
            Output: {formatTokenAmount(quote.details?.currencyOut?.amount, 6)} USDC
            (~${formatUSD(quote.details?.currencyOut?.amountUsd)})
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
              Gas Fee: {formatTokenAmount(quote.fees?.gas?.amount, 18)} ETH
              (~${formatUSD(quote.fees?.gas?.amountUsd)})
            </p>
            <p className="flex items-center">
              <FaGasPump className="w-4 h-4 mr-2 text-gray-500" />
              Relayer Fee: {formatTokenAmount(quote.fees?.relayer?.amount, 18)} ETH
              (~${formatUSD(quote.fees?.relayer?.amountUsd)})
            </p>
            <p className="flex items-center">
              <FaExchangeAlt className="w-4 h-4 mr-2 text-red-500" />
              Swap Impact: {quote.details?.swapImpact?.percent || '0'}% (~${formatUSD(quote.details?.swapImpact?.usd)})
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
    if (txHash) {
      navigator.clipboard.write(txHash);
      toast.info('Transaction hash copied!');
    }
  };

  return txHash ? (
    <div className="card mb-4">
      <h3 className="text-lg font-semibold text-gray-800 mb-2">Transaction Status</h3>
      <p className="text-sm flex items-center">
        <span className="font-semibold mr-1">Status:</span> {status || 'Pending'}
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

const ConfirmSellModal = ({ isOpen, onClose, onConfirm, quote, tokenInfo, isVerifiedAsset, balance }) => {
  const formatUSD = (value) => {
    if (!value || isNaN(value)) return '0.00';
    return parseFloat(value).toFixed(2);
  };
  const formatTokenAmount = (amount, decimals) => {
    if (!amount || !decimals) return '0';
    try {
      return ethers.utils.formatUnits(amount, decimals);
    } catch {
      return amount.toString();
    }
  };

  if (!quote || !tokenInfo) return null;

  const totalFeesUsd =
    parseFloat(quote.fees?.gas?.amountUsd || 0) +
    parseFloat(quote.fees?.relayer?.amountUsd || 0);
  const inputUsd = parseFloat(quote.details?.currencyIn?.amountUsd || 0);
  const isHighFee = inputUsd > 0 && totalFeesUsd / inputUsd > 0.1;
  const inputAmount = formatTokenAmount(quote.details?.currencyIn?.amount, tokenInfo.decimals);
  const isInsufficientBalance = balance !== null && parseFloat(balance) < parseFloat(inputAmount);

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
                      {inputAmount} {tokenInfo.symbol || 'Token'}
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
                  {!isVerifiedAsset && (
                    <p className="text-sm text-[var(--error)]">
                      ⚠ This is an unverified asset. Ensure you trust the token before proceeding.
                    </p>
                  )}
                  {isHighFee && (
                    <p className="text-sm text-[var(--error)]">
                      ⚠ High fees detected ({((totalFeesUsd / inputUsd) * 100).toFixed(1)}% of input). Proceed carefully.
                    </p>
                  )}
                  {isInsufficientBalance && (
                    <p className="text-sm text-[var(--error)]">
                      ⚠ Insufficient balance: {balance} {tokenInfo.symbol || 'Token'} available, {inputAmount} required.
                    </p>
                  )}
                </div>
                <div className="mt-4 flex justify-end space-x-2">
                  <button
                    onClick={onClose}
                    className="btn-secondary"
                    aria-label="Cancel sell transaction"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={onConfirm}
                    className="btn-primary"
                    disabled={isInsufficientBalance}
                    aria-label="Confirm sell transaction"
                  >
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
      aria-label="Contact support via Telegram"
    >
      Need help? Contact @maxcswap
    </a>
  </div>
);

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
  const [balance, setBalance] = useState(null);
  const [logoUri, setLogoUri] = useState(null);
  const [progress, setProgress] = useState(0);
  const location = useLocation();

  const formatUSD = (value) => {
    if (!value || isNaN(value)) return '0.00';
    return parseFloat(value).toFixed(2);
  };

  const formatTokenAmount = (amount, decimals) => {
    if (!amount || !decimals) return '0';
    try {
      return ethers.utils.formatUnits(amount, decimals);
    } catch {
      return amount.toString();
    }
  };

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

          if (response.data.token !== '0x0000000000000000000000000000000000000000') {
            try {
              const chainConfig = SUPPORTED_CHAINS[response.data.chainId];
              const provider = new ethers.providers.JsonRpcProvider(chainConfig.rpcUrl);
              const tokenContract = new ethers.Contract(
                response.data.token,
                [
                  'function symbol() view returns (string)',
                  'function decimals() view returns (uint8)',
                  'function balanceOf(address) view returns (uint256)',
                ],
                provider
              );
              const [symbol, decimals, balance] = await Promise.all([
                tokenContract.symbol(),
                tokenContract.decimals(),
                wallets[0]?.address
                  ? tokenContract.balanceOf(wallets[0].address)
                  : Promise.resolve(ethers.BigNumber.from(0)),
              ]);
              setTokenInfo({ symbol, decimals });
              setBalance(ethers.utils.formatUnits(balance, decimals));
              // Fetch logo from Relay.link
              const logoResponse = await axios.post('https://api.relay.link/currencies/v1', {
                chainIds: [response.data.chainId],
                term: response.data.token,
                verified: false,
                limit: 1,
              });
              const assets = logoResponse.data.flat();
              if (assets[0]?.metadata?.logoURI) {
                setLogoUri(assets[0].metadata.logoURI);
              }
            } catch (err) {
              console.error('Failed to fetch token metadata:', err);
              setTokenInfo({ symbol: 'Token', decimals: 18 });
              toast.warn('Could not fetch token details. Using default values.');
            }
          } else {
            const chainConfig = SUPPORTED_CHAINS[response.data.chainId];
            setTokenInfo({
              symbol: chainConfig?.nativeCurrency?.symbol || 'Token',
              decimals: chainConfig?.nativeCurrency?.decimals || 18,
            });
            try {
              const provider = new ethers.providers.JsonRpcProvider(chainConfig.rpcUrl);
              const balance = await provider.getBalance(wallets[0]?.address || ethers.constants.AddressZero);
              setBalance(ethers.utils.formatUnits(balance, chainConfig?.nativeCurrency?.decimals || 18));
            } catch (err) {
              console.error('Failed to fetch native balance:', err);
              setBalance('0');
            }
          }

          break;
        } catch (err) {
          console.error(`Attempt ${attempt} failed:`, err);
          if (attempt === retryCount) {
            setError(`Failed to fetch session: ${err.message}. Please try again or contact support at @maxcswap.`);
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
  }, [ready, authenticated, location.search, wallets]);

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
          setError(`Failed to switch to chain ID ${chainId}: ${err.message}. Please manually set your wallet to ${SUPPORTED_CHAINS[chainId].name}.`);
          setStatus('error');
          toast.error(`Failed to switch chains. Please set your wallet to ${SUPPORTED_CHAINS[chainId].name}.`);
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
      console.log(`Fetching quote for wallet ${wallets[0]?.address || 'unknown'}, session:`, session);
      const quote = await getClient().actions.getQuote({
        chainId: session.chainId,
        toChainId: 8453,
        currency: session.token,
        toCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        tradeType: 'EXACT_INPUT',
        amount: session.amountIn письма,
        wallet: adaptedWallet,
        recipient: session.blockradarWallet,
      });
      console.log('Quote response:', quote);
      setQuote(quote);
      setError(null);
      toast.success('Quote fetched successfully!');
      // Check balance sufficiency
      const inputAmount = formatTokenAmount(session.amountInWei, tokenInfo.decimals);
      if (balance && parseFloat(balance) < parseFloat(inputAmount)) {
        setError(`Insufficient ${tokenInfo.symbol} balance: ${balance} available, ${inputAmount} required. Please add funds to your wallet.`);
        toast.error('Insufficient balance. Please add funds to your wallet.');
      }
    } catch (err) {
      let errorMsg = err.message || 'Unknown error';
      let suggestion = 'Please try again or contact support at @maxcswap.';
      if (err.message?.includes('insufficient funds')) {
        errorMsg = 'Insufficient funds for gas or token amount.';
        suggestion = 'Please add funds to your wallet and try again.';
      } else if (err.message?.includes('network')) {
        errorMsg = 'Network error.';
        suggestion = 'Check your internet connection and try again.';
      } else if (err.message?.includes('unsupported token')) {
        errorMsg = `The token ${tokenInfo.symbol} may not be supported for bridging.`;
        suggestion = 'Try a different token or contact support.';
      }
      setError(`Failed to fetch quote: ${errorMsg} ${suggestion}`);
      setStatus('error');
      toast.error(`${errorMsg} ${suggestion}`);
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
    setProgress(10);

    try {
      await switchChain(session.chainId);
      let approvalCompleted = false;
      let signatureCompleted = false;

      await getClient().actions.execute({
        quote,
        wallet: adaptedWallet,
        depositGasLimit: '500000',
        onProgress: async (progress) => {
          console.log('Transaction progress:', progress);
          const { currentStep, currentStepItem, txHashes, error, refunded } = progress;

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

          if (currentStep?.id === 'approve' && !approvalCompleted) {
            setStatus('Awaiting approval in your wallet...');
            setProgress(30);
            if (currentStepItem?.data) {
              currentStepItem.data.gas = '50000';
            }
          }

          if (
            currentStep?.id === 'approve' &&
            currentStepItem?.status === 'complete'
          ) {
            setStatus('Approval completed. Preparing next step...');
            setProgress(50);
            toast.success('Token approval completed!');
            approvalCompleted = true;
          }

          if (currentStep?.id.includes('authorize') && !signatureCompleted) {
            setStatus('Awaiting signature in your wallet...');
            setProgress(60);
            if (currentStep.kind === 'signature' && currentStepItem?.data?.sign) {
              toast.info('Please sign the authorization.');
            }
          }

          if (
            currentStep?.id.includes('authorize') &&
            currentStepItem?.status === 'complete'
          ) {
            setStatus('Signature completed. Proceeding to deposit...');
            setProgress(70);
            toast.success('Authorization signed!');
            signatureCompleted = true;
          }

          if (
            currentStep?.id === 'deposit' &&
            (approvalCompleted || signatureCompleted)
          ) {
            await switchChain(session.chainId);
            setStatus('Depositing funds to relayer...');
            setProgress(80);
            toast.info('Please confirm the deposit transaction.');
          }

          if (txHashes && txHashes.length > 0) {
            const txHash = txHashes[txHashes.length - 1].txHash;
            const isBatch = txHashes[txHashes.length - 1].isBatchTx || false;
            setTxHash(txHash);
            setStatus(
              `Transaction ${isBatch ? 'batch ' : ''}submitted: ${txHash.slice(0, 6)}...`
            );
            setProgress(90);
            toast.success(
              `Transaction ${isBatch ? 'batch ' : ''}submitted: ${txHash.slice(0, 6)}...`
            );
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
          setProgress(100);
          toast.success('Sell completed! Funds will be sent to your bank.');
        } catch (webhookErr) {
          console.error('Webhook error:', webhookErr);
          setError(`Sell completed, but failed to notify server: ${webhookErr.message}. Contact support to verify your transaction.`);
          toast.warn('Sell completed, but server notification failed. Contact support.');
        }
      } else {
        throw new Error('No transaction hash received. Please try again.');
      }
    } catch (err) {
      console.error('Sell error:', err);
      let errorMsg = err.message || 'Unknown error';
      let suggestion = 'Please try again or contact support at @maxcswap.';
      if (err.name === 'DepositTransactionTimeoutError') {
        errorMsg = `Deposit transaction ${err.txHash || 'unknown'} is still pending.`;
        suggestion = 'Check your wallet for pending transactions or try again later.';
      } else if (err.name === 'TransactionConfirmationError') {
        errorMsg = `Transaction failed: ${err.message}.`;
        suggestion = 'Verify your wallet settings and try again.';
      } else if (err.message?.includes('user rejected')) {
        errorMsg = 'Transaction rejected.';
        suggestion = 'Please approve the transaction in your wallet.';
      } else if (err.message?.includes('insufficient')) {
        errorMsg = 'Insufficient funds for the transaction.';
        suggestion = 'Ensure you have enough funds for gas and tokens.';
      }
      setError(`Error during sell: ${errorMsg} ${suggestion}`);
      setStatus('error');
      toast.error(`${errorMsg} ${suggestion}`);
      setProgress(0);
    } finally {
      setLoading(false);
    }
  };

  const handleSellClick = () => {
    setIsConfirmOpen(true);
  };

  const handleConfirmSell = () => {
    setIsConfirmOpen(false);
    handleSell();
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
          setError(`Failed to initialize wallet for quote: ${err.message}. Please reconnect your wallet.`);
          setStatus('error');
          toast.error('Failed to initialize wallet. Please reconnect.');
        }
      })();
    }
  }, [wallets, session, ready, authenticated]);

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[var(--primary)]"></div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="card w-full max-w-lg">
        <div className="flex items-center mb-4">
          <img src="/logo.png" alt="DirectPay Logo" className="h-8 mr-2" />
          <h1 className="text-2xl font-bold text-gray-800">DirectPay</h1>
        </div>
        <ToastContainer position="top-right" autoClose={5000} role="alert" aria-live="assertive" />
        {!authenticated ? (
          <button
            onClick={login}
            className="btn-primary w-full"
            aria-label="Connect your cryptocurrency wallet"
          >
            Connect Wallet
          </button>
        ) : (
          <>
            <div className="card mb-4" role="region" aria-live="polite" aria-label="Wallet information">
              <p className="text-sm text-gray-600">
                <span className="font-semibold">Connected:</span>{' '}
                {wallets[0]?.address ? `${wallets[0].address.slice(0, 6)}...${wallets[0].address.slice(-4)}` : 'Unknown'}
              </p>
              <p className="text-sm text-gray-600">
                <span className="font-semibold">Status:</span> {status || 'Idle'}
              </p>
              {balance !== null && (
                <p className="text-sm text-gray-600">
                  <span className="font-semibold">Balance:</span> {parseFloat(balance).toFixed(4)} {tokenInfo.symbol || 'Token'}
                </p>
              )}
            </div>
            {session ? (
              <>
                <TransactionTimeline status={status} progress={progress} />
                <div className="card mb-4">
                  <h3 className="text-lg font-semibold text-gray-800 mb-2">Sell Details</h3>
                  <p className="text-sm">
                    <span className="font-semibold">Amount:</span>{' '}
                    {formatTokenAmount(session.amountInWei, tokenInfo.decimals)} {tokenInfo.symbol || 'Token'}
                  </p>
                  <p className="text-sm">
                    <span className="font-semibold">Chain:</span>{' '}
                    {SUPPORTED_CHAINS[session.chainId]?.name || 'Unknown'}
                  </p>
                  <p className="text-sm">
                    <span className="font-semibold">To:</span>{' '}
                    {session.blockradarWallet ? `${session.blockradarWallet.slice(0, 6)}...${session.blockradarWallet.slice(-4)}` : 'Unknown'}
                  </p>
                </div>
                {quote ? (
                  <>
                    <QuoteDisplay
                      quote={quote}
                      tokenInfo={tokenInfo}
                      logoUri={logoUri}
                      isVerifiedAsset={session.isVerifiedAsset !== false}
                    />
                    {txHash && (
                      <TransactionStatus
                        txHash={txHash}
                        chainId={session.chainId}
                        status={status}
                      />
                    )}
                    <button
                      onClick={handleSellClick}
                      disabled={loading}
                      className={`btn-primary w-full ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      aria-label="Execute sell transaction"
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
                      isVerifiedAsset={session.isVerifiedAsset !== false}
                      balance={balance}
                    />
                  </>
                ) : (
                  <p className="text-sm text-gray-500">
                    {loading ? 'Fetching quote...' : 'Waiting for quote...'}
                  </p>
                )}
                <button
                  onClick={logout}
                  className="btn-secondary w-full mt-4"
                  aria-label="Disconnect wallet"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <p className="text-sm text-gray-500">Fetching session...</p>
            )}
            {error && (
              <div className="alert-error" role="alert">
                {error}
              </div>
            )}
            <HelpSection />
          </>
        )}
      </div>
    </div>
  );
};

const App = () => (
  <PrivyProvider
    appId={process.env.REACT_APP_PRIVY_APP_ID || ''}
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
