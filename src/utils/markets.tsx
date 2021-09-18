import {
  Market,
  OpenOrders,
  Orderbook,
  DEX_ID,
  Side,
} from '@project-serum/serum';
import { PublicKey } from '@solana/web3.js';
import React, { useContext, useEffect, useState } from 'react';
import {
  divideBnToNumber,
  floorToDecimal,
  getTokenMultiplierFromDecimals,
  sleep,
  useLocalStorageState,
} from './utils';
import { refreshCache, useAsyncData } from './fetch-loop';
import { useAccountData, useAccountInfo, useConnection } from './connection';
import { useWallet } from './wallet';
import tuple from 'immutable-tuple';
import { notify } from './notifications';
import BN from 'bn.js';
import {
  getTokenAccountInfo,
  parseTokenAccountData,
  useMintInfos,
} from './tokens';
import {
  Balances,
  CustomMarketInfo,
  DeprecatedOpenOrdersBalances,
  FullMarketInfo,
  MarketContextValues,
  MarketInfo,
  OrderWithMarketAndMarketName,
  SelectedTokenAccounts,
  TokenAccount,
} from './types';
import BonfidaApi from './bonfidaConnector';
import { Slab } from '@bonfida/aaob';

export interface Order {
  orderId: BN;
  price: number;
  feeTier: number;
  size: number;
  openOrdersAddress: PublicKey;
  side: Side;
}

export const WRAPPED_SOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112',
);

const mint1 = new PublicKey('CZen4jVxdisrutQo2FeNY916uoeuEtLwfqSqJk9HHdEF');
const mint2 = new PublicKey('Cq47UeAkQcZmnaLPFpbHF8ZLjrPu4PhjshtsoKifMmMU');

const marketAddress = new PublicKey(
  'BT7i1viSJSQBHQ1jWVs7VWPBrY3gT5PLbYm9f62F7ZhR',
);

export const USE_MARKETS: MarketInfo[] = [
  {
    name: 'Test',
    address: marketAddress,
    programId: DEX_ID,
    deprecated: false,
  },
];

export const TOKEN_MINTS = [
  { name: 'Mint 1', address: mint1 },
  { name: 'Mint 2', address: mint2 },
];

// Used in debugging, should be false in production
const _IGNORE_DEPRECATED = false;

export function useMarketsList() {
  return USE_MARKETS.filter(
    ({ name, deprecated }) =>
      !deprecated && !process.env.REACT_APP_EXCLUDE_MARKETS?.includes(name),
  );
}

export function useAllMarkets() {
  const connection = useConnection();
  const { customMarkets } = useCustomMarkets();

  const getAllMarkets = async () => {
    const markets: Array<{
      market: Market;
      marketName: string;
      programId: PublicKey;
    } | null> = await Promise.all(
      getMarketInfos(customMarkets).map(async (marketInfo) => {
        try {
          const market = await Market.load(connection, marketInfo.address);
          return {
            market,
            marketName: marketInfo.name,
            programId: marketInfo.programId,
          };
        } catch (e) {
          notify({
            message: 'Error loading all market',
            // @ts-ignore
            description: e.message,
            type: 'error',
          });
          return null;
        }
      }),
    );
    return markets.filter(
      (m): m is { market: Market; marketName: string; programId: PublicKey } =>
        !!m,
    );
  };
  return useAsyncData(
    getAllMarkets,
    tuple('getAllMarkets', customMarkets.length, connection),
    { refreshInterval: _VERY_SLOW_REFRESH_INTERVAL },
  );
}

const MarketContext: React.Context<null | MarketContextValues> = React.createContext<null | MarketContextValues>(
  null,
);

const _VERY_SLOW_REFRESH_INTERVAL = 5000 * 1000;

// For things that don't really change
const _SLOW_REFRESH_INTERVAL = 5 * 1000;

// For things that change frequently
const _FAST_REFRESH_INTERVAL = 1000;

export const DEFAULT_MARKET = USE_MARKETS.find(
  ({ name, deprecated }) => name === 'SRM/USDT' && !deprecated,
);

export function getMarketDetails(
  market: Market | undefined | null,
  customMarkets: CustomMarketInfo[],
): FullMarketInfo {
  if (!market) {
    return {};
  }
  const marketInfos = getMarketInfos(customMarkets);
  const marketInfo = marketInfos.find((otherMarket) =>
    otherMarket.address.equals(market.address),
  );
  const baseCurrency =
    (market?.baseMintAddress &&
      TOKEN_MINTS.find((token) => token.address.equals(market.baseMintAddress))
        ?.name) ||
    (marketInfo?.baseLabel && `${marketInfo?.baseLabel}*`) ||
    'UNKNOWN';
  const quoteCurrency =
    (market?.quoteMintAddress &&
      TOKEN_MINTS.find((token) => token.address.equals(market.quoteMintAddress))
        ?.name) ||
    (marketInfo?.quoteLabel && `${marketInfo?.quoteLabel}*`) ||
    'UNKNOWN';

  return {
    ...marketInfo,
    marketName: marketInfo?.name,
    baseCurrency,
    quoteCurrency,
    marketInfo,
  };
}

export function useCustomMarkets() {
  const [customMarkets, setCustomMarkets] = useLocalStorageState<
    CustomMarketInfo[]
  >('customMarkets', []);
  return { customMarkets, setCustomMarkets };
}

export function MarketProvider({ marketAddress, setMarketAddress, children }) {
  const { customMarkets, setCustomMarkets } = useCustomMarkets();

  const address = marketAddress && new PublicKey(marketAddress);
  const connection = useConnection();
  const marketInfos = getMarketInfos(customMarkets);
  const marketInfo =
    address && marketInfos.find((market) => market.address.equals(address));

  // Replace existing market with a non-deprecated one on first load
  useEffect(() => {
    if (marketInfo && marketInfo.deprecated) {
      console.log('Switching markets from deprecated', marketInfo);
      if (DEFAULT_MARKET) {
        setMarketAddress(DEFAULT_MARKET.address.toBase58());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [market, setMarket] = useState<Market | null>();
  useEffect(() => {
    if (
      market &&
      marketInfo &&
      // @ts-ignore
      market._decoded.ownAddress?.equals(marketInfo?.address)
    ) {
      return;
    }
    setMarket(null);
    if (!marketInfo || !marketInfo.address) {
      notify({
        message: 'Error loading market',
        description: 'Please select a market from the dropdown',
        type: 'error',
      });
      return;
    }
    Market.load(connection, marketInfo.address)
      .then(setMarket)
      .catch((e) =>
        notify({
          message: 'Error loading market',
          description: e.message,
          type: 'error',
        }),
      );
    // eslint-disable-next-line
  }, [connection, marketInfo]);

  return (
    <MarketContext.Provider
      value={{
        market,
        ...getMarketDetails(market, customMarkets),
        setMarketAddress,
        customMarkets,
        setCustomMarkets,
      }}
    >
      {children}
    </MarketContext.Provider>
  );
}

export function getTradePageUrl(marketAddress?: string) {
  if (!marketAddress) {
    const saved = localStorage.getItem('marketAddress');
    if (saved) {
      marketAddress = JSON.parse(saved);
    }
    marketAddress = marketAddress || DEFAULT_MARKET?.address.toBase58() || '';
  }
  return `/market/${marketAddress}`;
}

export function useSelectedTokenAccounts(): [
  SelectedTokenAccounts,
  (newSelectedTokenAccounts: SelectedTokenAccounts) => void,
] {
  const [
    selectedTokenAccounts,
    setSelectedTokenAccounts,
  ] = useLocalStorageState<SelectedTokenAccounts>('selectedTokenAccounts', {});
  return [selectedTokenAccounts, setSelectedTokenAccounts];
}

export function useMarket() {
  const context = useContext(MarketContext);
  if (!context) {
    throw new Error('Missing market context');
  }
  return context;
}

export function useMarkPrice() {
  const [markPrice, setMarkPrice] = useState<null | number>(null);

  const [orderbook] = useOrderbook();
  const trades = useTrades();

  useEffect(() => {
    let bb = orderbook?.bids?.length > 0 && Number(orderbook.bids[0][0]);
    let ba = orderbook?.asks?.length > 0 && Number(orderbook.asks[0][0]);
    let last = trades && trades.length > 0 && trades[0].price;

    let markPrice =
      bb && ba
        ? last
          ? [bb, ba, last].sort((a, b) => a - b)[1]
          : (bb + ba) / 2
        : null;

    setMarkPrice(markPrice);
  }, [orderbook, trades]);

  return markPrice;
}

export function _useUnfilteredTrades(limit = 10000) {
  const { market } = useMarket();
  const connection = useConnection();
  async function getUnfilteredTrades(): Promise<any[] | null> {
    if (!market || !connection) {
      return null;
    }
    return await market.loadFills(connection, limit);
  }
  const [trades] = useAsyncData(
    getUnfilteredTrades,
    tuple('getUnfilteredTrades', market, connection),
    { refreshInterval: _SLOW_REFRESH_INTERVAL },
  );
  return trades;
  // NOTE: For now, websocket is too expensive since the event queue is large
  // and updates very frequently

  // let data = useAccountData(market && market._decoded.eventQueue);
  // if (!data) {
  //   return null;
  // }
  // const events = decodeEventQueue(data, limit);
  // return events
  //   .filter((event) => event.eventFlags.fill && event.nativeQuantityPaid.gtn(0))
  //   .map(market.parseFillEvent.bind(market));
}

export function useBonfidaTrades() {
  const { market } = useMarket();
  const marketAddress = market?.address.toBase58();

  async function getBonfidaTrades() {
    if (!marketAddress) {
      return null;
    }
    return await BonfidaApi.getRecentTrades(marketAddress);
  }

  return useAsyncData(
    getBonfidaTrades,
    tuple('getBonfidaTrades', marketAddress),
    { refreshInterval: _SLOW_REFRESH_INTERVAL },
    false,
  );
}

export function useOrderbookAccounts(): [
  Orderbook | null | undefined,
  boolean,
] {
  const connection = useConnection();
  const { market } = useMarket();
  const fn = async () => {
    if (!market) return;
    const orderbook = await Orderbook.load(connection, market.address);
    return orderbook;
  };
  return useAsyncData(
    fn,
    tuple('useOrderbookAccounts', market?.address.toBase58()),
  );
}

export function useOrderbook(
  depth = 20,
): [{ bids: number[][]; asks: number[][] }, boolean] {
  const [orderbook] = useOrderbookAccounts();

  const { market } = useMarket();
  const bids =
    !orderbook || !market
      ? []
      : orderbook.getL2(depth, false).map((p) => [p.price, p.quantity]);
  const asks =
    !orderbook || !market
      ? []
      : orderbook.getL2(depth, true).map((p) => [p.price, p.quantity]);
  return [{ bids, asks }, !!bids || !!asks];
}

// Want the balances table to be fast-updating, dont want open orders to flicker
// TODO: Update to use websocket
export function useOpenOrdersAccounts(fast = false) {
  const { market } = useMarket();
  const { connected, wallet } = useWallet();
  const connection = useConnection();
  async function getOpenOrdersAccounts() {
    if (!connected || !wallet) {
      return null;
    }
    if (!market) {
      return null;
    }
    return await market.findOpenOrdersAccountForOwner(
      connection,
      wallet.publicKey,
    );
  }
  return useAsyncData(
    getOpenOrdersAccounts,
    tuple('getOpenOrdersAccounts', wallet, market, connected),
    { refreshInterval: fast ? _FAST_REFRESH_INTERVAL : _SLOW_REFRESH_INTERVAL },
  );
}

export function useSelectedOpenOrdersAccount(fast = false) {
  const [accounts] = useOpenOrdersAccounts(fast);
  if (!accounts) {
    return null;
  }
  return accounts[0];
}

export function useTokenAccounts(): [
  TokenAccount[] | null | undefined,
  boolean,
] {
  const { connected, wallet } = useWallet();
  const connection = useConnection();
  async function getTokenAccounts() {
    if (!connected || !wallet) {
      return null;
    }
    return await getTokenAccountInfo(connection, wallet.publicKey);
  }
  return useAsyncData(
    getTokenAccounts,
    tuple('getTokenAccounts', wallet, connected),
    { refreshInterval: _SLOW_REFRESH_INTERVAL },
  );
}

export function getSelectedTokenAccountForMint(
  accounts: TokenAccount[] | undefined | null,
  mint: PublicKey | undefined,
  selectedPubKey?: string | PublicKey | null,
) {
  if (!accounts || !mint) {
    return null;
  }
  const filtered = accounts.filter(
    ({ effectiveMint, pubkey }) =>
      mint.equals(effectiveMint) &&
      (!selectedPubKey ||
        (typeof selectedPubKey === 'string'
          ? selectedPubKey
          : selectedPubKey.toBase58()) === pubkey.toBase58()),
  );
  return filtered && filtered[0];
}

export function useSelectedQuoteCurrencyAccount() {
  const [accounts] = useTokenAccounts();
  const { market } = useMarket();
  const [selectedTokenAccounts] = useSelectedTokenAccounts();
  const mintAddress = market?.quoteMintAddress;
  return getSelectedTokenAccountForMint(
    accounts,
    mintAddress,
    mintAddress && selectedTokenAccounts[mintAddress.toBase58()],
  );
}

export function useSelectedBaseCurrencyAccount() {
  const [accounts] = useTokenAccounts();
  const { market } = useMarket();
  const [selectedTokenAccounts] = useSelectedTokenAccounts();
  const mintAddress = market?.baseMintAddress;
  return getSelectedTokenAccountForMint(
    accounts,
    mintAddress,
    mintAddress && selectedTokenAccounts[mintAddress.toBase58()],
  );
}

// TODO: Update to use websocket
export function useSelectedQuoteCurrencyBalances() {
  const quoteCurrencyAccount = useSelectedQuoteCurrencyAccount();
  const { market } = useMarket();
  const [accountInfo, loaded] = useAccountInfo(quoteCurrencyAccount?.pubkey);
  if (!market || !quoteCurrencyAccount || !loaded || !accountInfo) {
    return null;
  }
  if (market.quoteMintAddress.equals(WRAPPED_SOL_MINT)) {
    return accountInfo?.lamports / 1e9 ?? 0;
  }
  return market.quoteSplSizeToNumber(
    new BN(accountInfo.data.slice(64, 72), 10, 'le'),
  );
}

// TODO: Update to use websocket
export function useSelectedBaseCurrencyBalances() {
  const baseCurrencyAccount = useSelectedBaseCurrencyAccount();
  const { market } = useMarket();
  const [accountInfo, loaded] = useAccountInfo(baseCurrencyAccount?.pubkey);
  if (!market || !baseCurrencyAccount || !loaded || !accountInfo) {
    return null;
  }
  if (market.baseMintAddress.equals(WRAPPED_SOL_MINT)) {
    return accountInfo?.lamports / 1e9 ?? 0;
  }
  return market.baseSplSizeToNumber(
    new BN(accountInfo.data.slice(64, 72), 10, 'le'),
  );
}

export function useOpenOrders() {
  const { market, marketName } = useMarket();
  const openOrdersAccount = useSelectedOpenOrdersAccount();
  const [orderbook] = useOrderbookAccounts();
  if (!market || !openOrdersAccount || !orderbook) {
    return null;
  }
  return market
    .filterForOpenOrders(orderbook, openOrdersAccount)
    .map((order) => ({ ...order, marketName, market }));
}

export function useTrades(limit = 100) {
  const trades = _useUnfilteredTrades(limit);
  if (!trades) {
    return null;
  }
  // Until partial fills are each given their own fill, use maker fills
  return trades
    .filter(({ eventFlags }) => eventFlags.maker)
    .map((trade) => ({
      ...trade,
      side: trade.side === 'buy' ? 'sell' : 'buy',
    }));
}

export function useLocallyStoredFeeDiscountKey(): {
  storedFeeDiscountKey: PublicKey | undefined;
  setStoredFeeDiscountKey: (key: string) => void;
} {
  const [
    storedFeeDiscountKey,
    setStoredFeeDiscountKey,
  ] = useLocalStorageState<string>(`feeDiscountKey`, undefined);
  return {
    storedFeeDiscountKey: storedFeeDiscountKey
      ? new PublicKey(storedFeeDiscountKey)
      : undefined,
    setStoredFeeDiscountKey,
  };
}

export function useFeeDiscountKeys(): [
  (
    | {
        pubkey: PublicKey;
        feeTier: number;
        balance: number;
        mint: PublicKey;
      }[]
    | null
    | undefined
  ),
  boolean,
] {
  const { market } = useMarket();
  const { connected, wallet } = useWallet();
  const connection = useConnection();
  const { setStoredFeeDiscountKey } = useLocallyStoredFeeDiscountKey();
  let getFeeDiscountKeys = async () => {
    if (!connected || !wallet) {
      return null;
    }
    if (!market) {
      return null;
    }
    const feeDiscountKey = await market.findFeeDiscountKeys(
      connection,
      wallet.publicKey,
    );
    if (feeDiscountKey) {
      setStoredFeeDiscountKey(feeDiscountKey[0].pubkey.toBase58());
    }
    return feeDiscountKey;
  };
  return useAsyncData(
    getFeeDiscountKeys,
    tuple('getFeeDiscountKeys', wallet, market, connected),
    { refreshInterval: _SLOW_REFRESH_INTERVAL },
  );
}

export function useFills(limit = 100) {
  const { marketName } = useMarket();
  const fills = _useUnfilteredTrades(limit);
  const [openOrdersAccounts] = useOpenOrdersAccounts();
  if (!openOrdersAccounts) {
    return null;
  }
  if (!fills) {
    return null;
  }
  return fills
    .filter((fill) => fill.openOrders.equals(openOrdersAccounts.address))
    .map((fill) => ({ ...fill, marketName }));
}

export function useAllOpenOrdersAccounts() {
  const { wallet, connected } = useWallet();
  const connection = useConnection();
  const marketInfos = useMarketInfos();

  const getAllOpenOrdersAccounts = async () => {
    if (!connected || !wallet) {
      return [];
    }
    return (
      await Promise.all(
        USE_MARKETS.map((market) =>
          OpenOrders.load(connection, market.address, wallet.publicKey),
        ),
      )
    ).flat();
  };
  return useAsyncData(
    getAllOpenOrdersAccounts,
    tuple(
      'getAllOpenOrdersAccounts',
      connection,
      connected,
      wallet?.publicKey?.toBase58(),
      marketInfos.length,
      (USE_MARKETS || []).length,
    ),
    { refreshInterval: _SLOW_REFRESH_INTERVAL },
  );
}

export function useAllOpenOrdersBalances() {
  const [
    openOrdersAccounts,
    loadedOpenOrdersAccounts,
  ] = useAllOpenOrdersAccounts();
  const [mintInfos, mintInfosConnected] = useMintInfos();
  const [allMarkets] = useAllMarkets();
  if (!loadedOpenOrdersAccounts || !mintInfosConnected) {
    return {};
  }

  const marketsByAddress = Object.fromEntries(
    (allMarkets || []).map((m) => [m.market.address.toBase58(), m]),
  );
  const openOrdersBalances: {
    [mint: string]: { market: PublicKey; free: number; total: number }[];
  } = {};
  for (let account of openOrdersAccounts || []) {
    const marketInfo = marketsByAddress[account.market.toBase58()];
    const baseMint = marketInfo?.market.baseMintAddress.toBase58();
    const quoteMint = marketInfo?.market.quoteMintAddress.toBase58();
    if (!(baseMint in openOrdersBalances)) {
      openOrdersBalances[baseMint] = [];
    }
    if (!(quoteMint in openOrdersBalances)) {
      openOrdersBalances[quoteMint] = [];
    }

    const baseMintInfo = mintInfos && mintInfos[baseMint];
    const baseFree = divideBnToNumber(
      new BN(account.baseTokenFree),
      getTokenMultiplierFromDecimals(baseMintInfo?.decimals || 0),
    );
    const baseTotal = divideBnToNumber(
      new BN(account.baseTokenTotal),
      getTokenMultiplierFromDecimals(baseMintInfo?.decimals || 0),
    );
    const quoteMintInfo = mintInfos && mintInfos[quoteMint];
    const quoteFree = divideBnToNumber(
      new BN(account.quoteTokenFree),
      getTokenMultiplierFromDecimals(quoteMintInfo?.decimals || 0),
    );
    const quoteTotal = divideBnToNumber(
      new BN(account.quoteTokenTotal),
      getTokenMultiplierFromDecimals(quoteMintInfo?.decimals || 0),
    );

    openOrdersBalances[baseMint].push({
      market: account.market,
      free: baseFree,
      total: baseTotal,
    });
    openOrdersBalances[quoteMint].push({
      market: account.market,
      free: quoteFree,
      total: quoteTotal,
    });
  }
  return openOrdersBalances;
}

export const useAllOpenOrders = (): {
  openOrders: { orders: Order[]; marketAddress: string }[] | null | undefined;
  loaded: boolean;
  refreshOpenOrders: () => void;
} => {
  const connection = useConnection();
  const { connected, wallet } = useWallet();
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [openOrders, setOpenOrders] = useState<
    { orders: Order[]; marketAddress: string }[] | null | undefined
  >(null);
  const [lastRefresh, setLastRefresh] = useState(0);

  const refreshOpenOrders = () => {
    if (new Date().getTime() - lastRefresh > 10 * 1000) {
      setRefresh((prev) => prev + 1);
    } else {
      console.log('not refreshing');
    }
  };

  useEffect(() => {
    if (connected && wallet) {
      const getAllOpenOrders = async () => {
        setLoaded(false);
        const _openOrders: { orders: Order[]; marketAddress: string }[] = [];
        const getOpenOrdersForMarket = async (marketInfo: MarketInfo) => {
          await sleep(1000 * Math.random()); // Try not to hit rate limit
          try {
            const market = await Market.load(connection, marketInfo.address);
            const orders = await market.loadOrdersForOwner(
              connection,
              wallet?.publicKey,
            );
            _openOrders.push({
              orders: orders,
              marketAddress: marketInfo.address.toBase58(),
            });
          } catch (e) {
            console.warn(`Error loading open order ${marketInfo.name} - ${e}`);
          }
        };
        await Promise.all(USE_MARKETS.map((m) => getOpenOrdersForMarket(m)));
        setOpenOrders(_openOrders);
        setLastRefresh(new Date().getTime());
        setLoaded(true);
      };
      getAllOpenOrders();
    }
  }, [connection, connected, wallet, refresh]);
  return {
    openOrders: openOrders,
    loaded: loaded,
    refreshOpenOrders: refreshOpenOrders,
  };
};

export function useBalances(): Balances[] {
  const baseCurrencyBalances = useSelectedBaseCurrencyBalances();
  const quoteCurrencyBalances = useSelectedQuoteCurrencyBalances();
  const openOrders = useSelectedOpenOrdersAccount(true);
  const { baseCurrency, quoteCurrency, market } = useMarket();
  const baseExists =
    openOrders && openOrders.baseTokenTotal && openOrders.baseTokenFree;
  const quoteExists =
    openOrders && openOrders.quoteTokenTotal && openOrders.quoteTokenFree;
  if (
    baseCurrency === 'UNKNOWN' ||
    quoteCurrency === 'UNKNOWN' ||
    !baseCurrency ||
    !quoteCurrency
  ) {
    return [];
  }
  return [
    {
      market,
      key: `${baseCurrency}${quoteCurrency}${baseCurrency}`,
      coin: baseCurrency,
      wallet: baseCurrencyBalances,
      orders:
        baseExists && market && openOrders
          ? market.baseSplSizeToNumber(
              openOrders.baseTokenTotal.sub(openOrders.baseTokenFree),
            )
          : null,
      openOrders,
      unsettled:
        baseExists && market && openOrders
          ? market.baseSplSizeToNumber(openOrders.baseTokenFree)
          : null,
    },
    {
      market,
      key: `${quoteCurrency}${baseCurrency}${quoteCurrency}`,
      coin: quoteCurrency,
      wallet: quoteCurrencyBalances,
      openOrders,
      orders:
        quoteExists && market && openOrders
          ? market.quoteSplSizeToNumber(
              openOrders.quoteTokenTotal.sub(openOrders.quoteTokenFree),
            )
          : null,
      unsettled:
        quoteExists && market && openOrders
          ? market.quoteSplSizeToNumber(openOrders.quoteTokenFree)
          : null,
    },
  ];
}

export function useWalletBalancesForAllMarkets(): {
  mint: string;
  balance: number;
}[] {
  const [tokenAccounts] = useTokenAccounts();
  const { connected } = useWallet();
  const [mintInfos, mintInfosConnected] = useMintInfos();

  if (!connected || !mintInfosConnected) {
    return [];
  }

  let balances: { [mint: string]: number } = {};
  for (let account of tokenAccounts || []) {
    if (!account.account) {
      continue;
    }
    let parsedAccount;
    if (account.effectiveMint.equals(WRAPPED_SOL_MINT)) {
      parsedAccount = {
        mint: WRAPPED_SOL_MINT,
        owner: account.pubkey,
        amount: account.account.lamports,
      };
    } else {
      parsedAccount = parseTokenAccountData(account.account.data);
    }
    if (!(parsedAccount.mint.toBase58() in balances)) {
      balances[parsedAccount.mint.toBase58()] = 0;
    }
    const mintInfo = mintInfos && mintInfos[parsedAccount.mint.toBase58()];
    const additionalAmount = divideBnToNumber(
      new BN(parsedAccount.amount),
      getTokenMultiplierFromDecimals(mintInfo?.decimals || 0),
    );
    balances[parsedAccount.mint.toBase58()] += additionalAmount;
  }
  return Object.entries(balances).map(([mint, balance]) => {
    return { mint, balance };
  });
}

// export function useUnmigratedDeprecatedMarkets() {
//   const connection = useConnection();
//   const { accounts } = useUnmigratedOpenOrdersAccounts();
//   const marketsList =
//     accounts &&
//     Array.from(new Set(accounts.map((openOrders) => openOrders.market)));
//   const deps = marketsList && marketsList.map((m) => m.toBase58());

//   const useUnmigratedDeprecatedMarketsInner = async () => {
//     if (!marketsList) {
//       return null;
//     }
//     const getMarket = async (address) => {
//       const marketInfo = USE_MARKETS.find((market) =>
//         market.address.equals(address),
//       );
//       if (!marketInfo) {
//         console.log('Failed loading market');
//         notify({
//           message: 'Error loading market',
//           type: 'error',
//         });
//         return null;
//       }
//       try {
//         console.log('Loading market', marketInfo.name);
//         // NOTE: Should this just be cached by (connection, marketInfo.address, marketInfo.programId)?
//         return await Market.load(
//           connection,
//           marketInfo.address,
//           {},
//           marketInfo.programId,
//         );
//       } catch (e) {
//         console.log('Failed loading market', marketInfo.name, e);
//         notify({
//           message: 'Error loading market',
//           description: e.message,
//           type: 'error',
//         });
//         return null;
//       }
//     };
//     return (await Promise.all(marketsList.map(getMarket))).filter((x) => x);
//   };
//   const [markets] = useAsyncData(
//     useUnmigratedDeprecatedMarketsInner,
//     tuple(
//       'useUnmigratedDeprecatedMarketsInner',
//       connection,
//       deps && deps.toString(),
//     ),
//     { refreshInterval: _VERY_SLOW_REFRESH_INTERVAL },
//   );
//   if (!markets) {
//     return null;
//   }
//   return markets.map((market) => ({
//     market,
//     openOrdersList: accounts?.filter(
//       (openOrders) => market && openOrders.market.equals(market.address),
//     ),
//   }));
// }

// export function useGetOpenOrdersForDeprecatedMarkets(): {
//   openOrders: OrderWithMarketAndMarketName[] | null | undefined;
//   loaded: boolean;
//   refreshOpenOrders: () => void;
// } {
//   const { connected, wallet } = useWallet();
//   const { customMarkets } = useCustomMarkets();
//   const connection = useConnection();
//   const marketsAndOrders = useUnmigratedDeprecatedMarkets();
//   const marketsList =
//     marketsAndOrders && marketsAndOrders.map(({ market }) => market);

//   // This isn't quite right: open order balances could change
//   const deps =
//     marketsList &&
//     marketsList
//       .filter((market): market is Market => !!market)
//       .map((market) => market.address.toBase58());

//   async function getOpenOrdersForDeprecatedMarkets() {
//     if (!connected || !wallet) {
//       return null;
//     }
//     if (!marketsList) {
//       return null;
//     }
//     console.log('refreshing getOpenOrdersForDeprecatedMarkets');
//     const getOrders = async (market: Market | null) => {
//       if (!market) {
//         return null;
//       }
//       const { marketName } = getMarketDetails(market, customMarkets);
//       try {
//         console.log('Fetching open orders for', marketName);
//         // Can do better than this, we have the open orders accounts already
//         return (
//           await market.loadOrdersForOwner(connection, wallet.publicKey)
//         ).map((order) => ({ marketName, market, ...order }));
//       } catch (e) {
//         console.log('Failed loading open orders', market.address.toBase58(), e);
//         notify({
//           message: `Error loading open orders for deprecated ${marketName}`,
//           description: e.message,
//           type: 'error',
//         });
//         return null;
//       }
//     };
//     return (await Promise.all(marketsList.map(getOrders)))
//       .filter((x): x is OrderWithMarketAndMarketName[] => !!x)
//       .flat();
//   }

//   const cacheKey = tuple(
//     'getOpenOrdersForDeprecatedMarkets',
//     connected,
//     connection,
//     wallet,
//     deps && deps.toString(),
//   );
//   const [openOrders, loaded] = useAsyncData(
//     getOpenOrdersForDeprecatedMarkets,
//     cacheKey,
//     {
//       refreshInterval: _VERY_SLOW_REFRESH_INTERVAL,
//     },
//   );
//   console.log('openOrders', openOrders);
//   return {
//     openOrders,
//     loaded,
//     refreshOpenOrders: () => refreshCache(cacheKey),
//   };
// }

// export function useBalancesForDeprecatedMarkets() {
//   const markets = useUnmigratedDeprecatedMarkets();
//   const [customMarkets] = useLocalStorageState<CustomMarketInfo[]>(
//     'customMarkets',
//     [],
//   );
//   if (!markets) {
//     return null;
//   }

//   const openOrderAccountBalances: DeprecatedOpenOrdersBalances[] = [];
//   markets.forEach(({ market, openOrdersList }) => {
//     const { baseCurrency, quoteCurrency, marketName } = getMarketDetails(
//       market,
//       customMarkets,
//     );
//     if (!baseCurrency || !quoteCurrency || !market) {
//       return;
//     }
//     (openOrdersList || []).forEach((openOrders) => {
//       const inOrdersBase =
//         openOrders?.baseTokenTotal &&
//         openOrders?.baseTokenFree &&
//         market.baseSplSizeToNumber(
//           openOrders.baseTokenTotal.sub(openOrders.baseTokenFree),
//         );
//       const inOrdersQuote =
//         openOrders?.quoteTokenTotal &&
//         openOrders?.quoteTokenFree &&
//         market.baseSplSizeToNumber(
//           openOrders.quoteTokenTotal.sub(openOrders.quoteTokenFree),
//         );
//       const unsettledBase =
//         openOrders?.baseTokenFree &&
//         market.baseSplSizeToNumber(openOrders.baseTokenFree);
//       const unsettledQuote =
//         openOrders?.quoteTokenFree &&
//         market.baseSplSizeToNumber(openOrders.quoteTokenFree);

//       openOrderAccountBalances.push({
//         marketName,
//         market,
//         coin: baseCurrency,
//         key: `${marketName}${baseCurrency}`,
//         orders: inOrdersBase,
//         unsettled: unsettledBase,
//         openOrders,
//       });
//       openOrderAccountBalances.push({
//         marketName,
//         market,
//         coin: quoteCurrency,
//         key: `${marketName}${quoteCurrency}`,
//         orders: inOrdersQuote,
//         unsettled: unsettledQuote,
//         openOrders,
//       });
//     });
//   });
//   return openOrderAccountBalances;
// }

export function getMarketInfos(
  customMarkets: CustomMarketInfo[],
): MarketInfo[] {
  const customMarketsInfo = customMarkets.map((m) => ({
    ...m,
    address: new PublicKey(m.address),
    programId: new PublicKey(m.programId),
    deprecated: false,
  }));

  return [...customMarketsInfo, ...USE_MARKETS];
}

export function useMarketInfos() {
  const { customMarkets } = useCustomMarkets();
  return getMarketInfos(customMarkets);
}

/**
 * If selling, choose min tick size. If buying choose a price
 * s.t. given the state of the orderbook, the order will spend
 * `cost` cost currency.
 *
 * @param orderbook serum Orderbook object
 * @param cost quantity to spend. Base currency if selling,
 *  quote currency if buying.
 * @param tickSizeDecimals size of price increment of the market
 */
// export function getMarketOrderPrice(
//   orderbook: Orderbook,
//   cost: number,
//   tickSizeDecimals?: number,
// ) {
//   if (orderbook.isBids) {
//     return orderbook.market.tickSize;
//   }
//   let spentCost = 0;
//   let price, sizeAtLevel, costAtLevel: number;
//   const asks = orderbook.getL2(1000);
//   for ([price, sizeAtLevel] of asks) {
//     costAtLevel = price * sizeAtLevel;
//     if (spentCost + costAtLevel > cost) {
//       break;
//     }
//     spentCost += costAtLevel;
//   }
//   const sendPrice = Math.min(price * 1.02, asks[0][0] * 1.05);
//   let formattedPrice;
//   if (tickSizeDecimals) {
//     formattedPrice = floorToDecimal(sendPrice, tickSizeDecimals);
//   } else {
//     formattedPrice = sendPrice;
//   }
//   return formattedPrice;
// }

export function getExpectedFillPrice(
  orderbook: Orderbook,
  cost: number,
  asks: boolean,
  tickSizeDecimals?: number,
) {
  let spentCost = 0;
  let avgPrice = 0;
  let price, sizeAtLevel, costAtLevel: number;
  for (price of orderbook.getL2(1000, asks)) {
    costAtLevel = (!asks ? 1 : price) * sizeAtLevel;
    if (spentCost + costAtLevel > cost) {
      avgPrice += (cost - spentCost) * price;
      spentCost = cost;
      break;
    }
    avgPrice += costAtLevel * price;
    spentCost += costAtLevel;
  }
  const totalAvgPrice = avgPrice / Math.min(cost, spentCost);
  let formattedPrice;
  if (tickSizeDecimals) {
    formattedPrice = floorToDecimal(totalAvgPrice, tickSizeDecimals);
  } else {
    formattedPrice = totalAvgPrice;
  }
  return formattedPrice;
}

export function useCurrentlyAutoSettling(): [
  boolean,
  (currentlyAutoSettling: boolean) => void,
] {
  const [currentlyAutoSettling, setCurrentlyAutosettling] = useState<boolean>(
    false,
  );
  return [currentlyAutoSettling, setCurrentlyAutosettling];
}
