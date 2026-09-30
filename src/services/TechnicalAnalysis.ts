/**
 * TechnicalAnalysis — pure functions for computing common technical indicators.
 *
 * All inputs are plain number arrays ordered oldest → newest.
 * Every function returns NaN for positions where insufficient data exists.
 */

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export interface BollingerBandsResult {
  upper: number[];
  middle: number[];
  lower: number[];
}

export interface StochasticResult {
  k: number[];
  d: number[];
}

export interface AnalysisResult {
  sma20: number[];
  sma50: number[];
  ema12: number[];
  ema26: number[];
  rsi14: number[];
  macd: MACDResult;
  bollingerBands: BollingerBandsResult;
  atr14: number[];
  obv: number[];
  vwap: number[];
  stochastic: StochasticResult;
  signals: TradingSignal[];
}

export interface TradingSignal {
  index: number;
  date?: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  reason: string;
  strength: 'strong' | 'moderate' | 'weak';
}

// ---------------------------------------------------------------------------
// Core indicator functions
// ---------------------------------------------------------------------------

export class TechnicalAnalysis {

  /** Simple Moving Average */
  static sma(prices: number[], period: number): number[] {
    return prices.map((_, i) => {
      if (i < period - 1) return NaN;
      const slice = prices.slice(i - period + 1, i + 1);
      return slice.reduce((a, b) => a + b, 0) / period;
    });
  }

  /** Exponential Moving Average */
  static ema(prices: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const result: number[] = new Array(prices.length).fill(NaN);
    // Seed with SMA of first `period` values
    let seedSum = 0;
    let seedCount = 0;
    for (let i = 0; i < prices.length; i++) {
      if (i < period - 1) {
        seedSum += prices[i];
        seedCount++;
        continue;
      }
      if (i === period - 1) {
        seedSum += prices[i];
        result[i] = seedSum / period;
      } else {
        result[i] = prices[i] * k + result[i - 1] * (1 - k);
      }
    }
    return result;
  }

  /**
   * Relative Strength Index (Wilder's smoothed method).
   * Returns NaN for the first `period` values.
   */
  static rsi(prices: number[], period = 14): number[] {
    const result: number[] = new Array(prices.length).fill(NaN);
    if (prices.length < period + 1) return result;

    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i++) {
      const delta = prices[i] - prices[i - 1];
      avgGain += Math.max(delta, 0);
      avgLoss += Math.max(-delta, 0);
    }
    avgGain /= period;
    avgLoss /= period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);

    for (let i = period + 1; i < prices.length; i++) {
      const delta = prices[i] - prices[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
      const r = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + r);
    }

    return result;
  }

  /**
   * MACD — Moving Average Convergence Divergence.
   * Default: fast=12, slow=26, signal=9.
   */
  static macd(prices: number[], fast = 12, slow = 26, signal = 9): MACDResult {
    const fastEma = this.ema(prices, fast);
    const slowEma = this.ema(prices, slow);
    const macdLine = fastEma.map((v, i) =>
      Number.isNaN(v) || Number.isNaN(slowEma[i]) ? NaN : v - slowEma[i],
    );
    // Signal line = EMA of MACD line
    const validMacd = macdLine.map(v => (Number.isNaN(v) ? 0 : v));
    const signalLine = this.ema(validMacd, signal).map((v, i) =>
      Number.isNaN(macdLine[i]) ? NaN : v,
    );
    const histogram = macdLine.map((v, i) =>
      Number.isNaN(v) || Number.isNaN(signalLine[i]) ? NaN : v - signalLine[i],
    );
    return { macd: macdLine, signal: signalLine, histogram };
  }

  /**
   * Bollinger Bands — middle = SMA(period), upper/lower = middle ± stdDev * σ.
   */
  static bollingerBands(prices: number[], period = 20, stdDev = 2): BollingerBandsResult {
    const middle = this.sma(prices, period);
    const upper: number[] = new Array(prices.length).fill(NaN);
    const lower: number[] = new Array(prices.length).fill(NaN);

    for (let i = period - 1; i < prices.length; i++) {
      const slice = prices.slice(i - period + 1, i + 1);
      const mean = middle[i];
      const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      upper[i] = mean + stdDev * sd;
      lower[i] = mean - stdDev * sd;
    }

    return { upper, middle, lower };
  }

  /**
   * Average True Range — measures market volatility.
   * Requires parallel high, low, close arrays of the same length.
   */
  static atr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
    const n = Math.min(highs.length, lows.length, closes.length);
    const trueRanges: number[] = new Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
      trueRanges[i] = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      );
    }

    // Wilder smoothing (same as RSI)
    const result: number[] = new Array(n).fill(NaN);
    let seed = 0;
    let seedCount = 0;
    for (let i = 1; i <= period && i < n; i++) {
      seed += trueRanges[i];
      seedCount++;
    }
    if (seedCount === period) {
      result[period] = seed / period;
      for (let i = period + 1; i < n; i++) {
        result[i] = (result[i - 1] * (period - 1) + trueRanges[i]) / period;
      }
    }
    return result;
  }

  /**
   * On-Balance Volume — cumulative volume momentum indicator.
   */
  static obv(closes: number[], volumes: number[]): number[] {
    const n = Math.min(closes.length, volumes.length);
    const result: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      if (closes[i] > closes[i - 1]) {
        result[i] = result[i - 1] + volumes[i];
      } else if (closes[i] < closes[i - 1]) {
        result[i] = result[i - 1] - volumes[i];
      } else {
        result[i] = result[i - 1];
      }
    }
    return result;
  }

  /**
   * Volume-Weighted Average Price — daily VWAP from intraday or daily bar data.
   */
  static vwap(highs: number[], lows: number[], closes: number[], volumes: number[]): number[] {
    const n = Math.min(highs.length, lows.length, closes.length, volumes.length);
    const result: number[] = new Array(n).fill(NaN);
    let cumulativeTPV = 0; // typical_price * volume
    let cumulativeVol = 0;

    for (let i = 0; i < n; i++) {
      const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
      cumulativeTPV += typicalPrice * volumes[i];
      cumulativeVol += volumes[i];
      result[i] = cumulativeVol === 0 ? NaN : cumulativeTPV / cumulativeVol;
    }
    return result;
  }

  /**
   * Stochastic Oscillator %K and %D.
   */
  static stochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    kPeriod = 14,
    dPeriod = 3,
  ): StochasticResult {
    const n = Math.min(highs.length, lows.length, closes.length);
    const k: number[] = new Array(n).fill(NaN);

    for (let i = kPeriod - 1; i < n; i++) {
      const periodHighs = highs.slice(i - kPeriod + 1, i + 1);
      const periodLows = lows.slice(i - kPeriod + 1, i + 1);
      const highestHigh = Math.max(...periodHighs);
      const lowestLow = Math.min(...periodLows);
      const range = highestHigh - lowestLow;
      k[i] = range === 0 ? 50 : ((closes[i] - lowestLow) / range) * 100;
    }

    const d = this.sma(k.map(v => (Number.isNaN(v) ? 0 : v)), dPeriod).map((v, i) =>
      Number.isNaN(k[i]) ? NaN : v,
    );

    return { k, d };
  }

  // ---------------------------------------------------------------------------
  // Signal generation
  // ---------------------------------------------------------------------------

  /**
   * Combines multiple indicators to generate BUY/SELL/HOLD signals.
   */
  static generateSignals(
    closes: number[],
    highs: number[],
    lows: number[],
    volumes: number[],
    dates?: string[],
  ): TradingSignal[] {
    const rsi = this.rsi(closes, 14);
    const stoch = this.stochastic(highs, lows, closes);
    const obvLine = this.obv(closes, volumes);
    const { histogram } = this.macd(closes);
    const bb = this.bollingerBands(closes, 20, 2);
    const sma20 = this.sma(closes, 20);
    const sma50 = this.sma(closes, 50);
    const signals: TradingSignal[] = [];

    for (let i = 50; i < closes.length; i++) {
      const reasons: string[] = [];
      let bullScore = 0;
      let bearScore = 0;

      // RSI signals
      if (!Number.isNaN(rsi[i])) {
        if (rsi[i] < 30) { reasons.push(`RSI oversold (${rsi[i].toFixed(1)})`); bullScore += 2; }
        else if (rsi[i] > 70) { reasons.push(`RSI overbought (${rsi[i].toFixed(1)})`); bearScore += 2; }
      }

      // MACD crossover
      if (!Number.isNaN(histogram[i]) && !Number.isNaN(histogram[i - 1])) {
        if (histogram[i] > 0 && histogram[i - 1] <= 0) { reasons.push('MACD bullish crossover'); bullScore += 2; }
        else if (histogram[i] < 0 && histogram[i - 1] >= 0) { reasons.push('MACD bearish crossover'); bearScore += 2; }
      }

      // Bollinger Band touches
      if (!Number.isNaN(bb.lower[i]) && closes[i] <= bb.lower[i]) {
        reasons.push('Price at lower Bollinger Band'); bullScore += 1;
      } else if (!Number.isNaN(bb.upper[i]) && closes[i] >= bb.upper[i]) {
        reasons.push('Price at upper Bollinger Band'); bearScore += 1;
      }

      // SMA trend alignment
      if (!Number.isNaN(sma20[i]) && !Number.isNaN(sma50[i])) {
        if (sma20[i] > sma50[i] && closes[i] > sma20[i]) { reasons.push('Price above SMA20 > SMA50'); bullScore += 1; }
        else if (sma20[i] < sma50[i] && closes[i] < sma20[i]) { reasons.push('Price below SMA20 < SMA50'); bearScore += 1; }
      }

      // Stochastic %K oversold/overbought
      if (!Number.isNaN(stoch.k[i])) {
        if (stoch.k[i] < 20) { reasons.push(`Stochastic oversold (%K=${stoch.k[i].toFixed(1)})`); bullScore += 1; }
        else if (stoch.k[i] > 80) { reasons.push(`Stochastic overbought (%K=${stoch.k[i].toFixed(1)})`); bearScore += 1; }
      }

      // OBV divergence (rising OBV + rising price = confirmed trend)
      if (i >= 1 && !Number.isNaN(obvLine[i]) && !Number.isNaN(obvLine[i - 1])) {
        const obvRising = obvLine[i] > obvLine[i - 1];
        const priceRising = closes[i] > closes[i - 1];
        if (obvRising && priceRising) { bullScore += 1; }
        else if (!obvRising && !priceRising) { bearScore += 1; }
      }

      if (bullScore === 0 && bearScore === 0) continue;

      const net = bullScore - bearScore;
      let sig: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
      let strength: 'strong' | 'moderate' | 'weak' = 'weak';

      if (net >= 3) { sig = 'BUY'; strength = 'strong'; }
      else if (net >= 1) { sig = 'BUY'; strength = net === 1 ? 'weak' : 'moderate'; }
      else if (net <= -3) { sig = 'SELL'; strength = 'strong'; }
      else if (net <= -1) { sig = 'SELL'; strength = net === -1 ? 'weak' : 'moderate'; }

      signals.push({
        index: i,
        date: dates?.[i],
        signal: sig,
        reason: reasons.join('; '),
        strength,
      });
    }

    return signals;
  }

  // ---------------------------------------------------------------------------
  // Convenience: run full analysis on OHLCV data
  // ---------------------------------------------------------------------------

  static analyze(
    closes: number[],
    highs: number[],
    lows: number[],
    volumes: number[],
    dates?: string[],
  ): AnalysisResult {
    return {
      sma20: this.sma(closes, 20),
      sma50: this.sma(closes, 50),
      ema12: this.ema(closes, 12),
      ema26: this.ema(closes, 26),
      rsi14: this.rsi(closes, 14),
      macd: this.macd(closes),
      bollingerBands: this.bollingerBands(closes, 20, 2),
      atr14: this.atr(highs, lows, closes, 14),
      obv: this.obv(closes, volumes),
      vwap: this.vwap(highs, lows, closes, volumes),
      stochastic: this.stochastic(highs, lows, closes),
      signals: this.generateSignals(closes, highs, lows, volumes, dates),
    };
  }
}
