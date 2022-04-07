import { BN } from '@project-serum/anchor';
import {
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	ZERO,
} from '../constants/numericConstants';
import {
	AMM,
	PositionDirection,
	SwapDirection,
	Market,
	isVariant,
	OracleSource,
} from '../types';
import { assert } from '../assert/assert';
import {
	calculatePositionPNL,
	calculateMarkPrice,
	convertToNumber,
	squareRootBN,
} from '..';
import {
	calculateSwapOutputCpSq,
	calculateSwapOutputCp,
	calculatePriceCp,
	calculatePriceCpSq,
} from './curve';

export const matchEnum = (enum1: any, enum2) => {
	return JSON.stringify(enum1) === JSON.stringify(enum2);
};

/**
 * Calculates a price given an arbitrary base and quote amount (they must have the same precision)
 *
 * @param baseAssetAmount
 * @param quoteAssetAmount
 * @param peg_multiplier
 * @returns price : Precision MARK_PRICE_PRECISION
 */
export function calculatePrice(
	amm: AMM,
	baseAssetAmount: BN,
	quoteAssetAmount: BN,
	peg_multiplier: BN
): BN {
	if (baseAssetAmount.abs().lte(ZERO)) {
		return new BN(0);
	}

	if (matchEnum(amm.oracleSource, OracleSource.PYTHSQUARED)) {
		return calculatePriceCpSq(
			baseAssetAmount,
			quoteAssetAmount,
			peg_multiplier
		);
	} else {
		return calculatePriceCp(baseAssetAmount, quoteAssetAmount, peg_multiplier);
	}
}

export type AssetType = 'quote' | 'base';

/**
 * Calculates what the amm reserves would be after swapping a quote or base asset amount.
 *
 * @param amm
 * @param inputAssetType
 * @param swapAmount
 * @param swapDirection
 * @returns quoteAssetReserve and baseAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateAmmReservesAfterSwap(
	amm: AMM,
	inputAssetType: AssetType,
	swapAmount: BN,
	swapDirection: SwapDirection
): [BN, BN] {
	assert(swapAmount.gte(ZERO), 'swapAmount must be greater than 0');

	let newQuoteAssetReserve;
	let newBaseAssetReserve;

	if (inputAssetType === 'quote') {
		swapAmount = swapAmount
			.mul(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)
			.div(amm.pegMultiplier);

		console.log('CHECKING ORACLE SOURCE', amm.oracleSource);
		console.log(OracleSource.PYTHSQUARED);
		if (matchEnum(amm.oracleSource, OracleSource.PYTHSQUARED)) {
			console.log('PYTHSQ', amm.oracleSource);
			[newQuoteAssetReserve, newBaseAssetReserve] = calculateSwapOutputCpSq(
				amm.quoteAssetReserve,
				swapAmount,
				swapDirection,
				amm.sqrtK.mul(amm.sqrtK),
				inputAssetType
			);
		} else {
			[newQuoteAssetReserve, newBaseAssetReserve] = calculateSwapOutputCp(
				amm.quoteAssetReserve,
				swapAmount,
				swapDirection,
				amm.sqrtK.mul(amm.sqrtK),
				inputAssetType
			);
		}
	} else {
		console.log('CHECKING ORACLE SOURCE', amm.oracleSource);
		console.log(OracleSource.PYTHSQUARED);
		console.log(matchEnum(amm.oracleSource, OracleSource.PYTHSQUARED));
		if (matchEnum(amm.oracleSource, OracleSource.PYTHSQUARED)) {
			console.log('PYTHSQ', amm.oracleSource);

			[newBaseAssetReserve, newQuoteAssetReserve] = calculateSwapOutputCpSq(
				amm.baseAssetReserve,
				swapAmount,
				swapDirection,
				amm.sqrtK.mul(amm.sqrtK),
				inputAssetType
			);
		} else {
			[newBaseAssetReserve, newQuoteAssetReserve] = calculateSwapOutputCp(
				amm.baseAssetReserve,
				swapAmount,
				swapDirection,
				amm.sqrtK.mul(amm.sqrtK),
				inputAssetType
			);
		}
	}

	return [newQuoteAssetReserve, newBaseAssetReserve];
}

/**
 * Helper function calculating constant product curve output. Agnostic to whether input asset is quote or base
 *
 * @param inputAssetReserve
 * @param swapAmount
 * @param swapDirection
 * @param invariant
 * @returns newInputAssetReserve and newOutputAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateSwapOutput(
	inputAssetReserve: BN,
	swapAmount: BN,
	swapDirection: SwapDirection,
	invariant: BN,
	inputAssetType: AssetType
): [BN, BN] {
	let newInputAssetReserve;
	if (swapDirection === SwapDirection.ADD) {
		newInputAssetReserve = inputAssetReserve.add(swapAmount);
	} else {
		newInputAssetReserve = inputAssetReserve.sub(swapAmount);
	}
	const newOutputAssetReserve = invariant.div(newInputAssetReserve);
	return [newInputAssetReserve, newOutputAssetReserve];
}

/**
 * Translate long/shorting quote/base asset into amm operation
 *
 * @param inputAssetType
 * @param positionDirection
 */
export function getSwapDirection(
	inputAssetType: AssetType,
	positionDirection: PositionDirection
): SwapDirection {
	if (isVariant(positionDirection, 'long') && inputAssetType === 'base') {
		return SwapDirection.REMOVE;
	}

	if (isVariant(positionDirection, 'short') && inputAssetType === 'quote') {
		return SwapDirection.REMOVE;
	}

	return SwapDirection.ADD;
}

/**
 * Helper function calculating terminal price of amm
 *
 * @param market
 * @returns cost : Precision MARK_PRICE_PRECISION
 */
export function calculateTerminalPrice(market: Market) {
	const directionToClose = market.baseAssetAmount.gt(ZERO)
		? PositionDirection.SHORT
		: PositionDirection.LONG;

	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			market.baseAssetAmount.abs(),
			getSwapDirection('base', directionToClose)
		);

	const terminalPrice = newQuoteAssetReserve
		.mul(MARK_PRICE_PRECISION)
		.mul(market.amm.pegMultiplier)
		.div(PEG_PRECISION)
		.div(newBaseAssetReserve);

	return terminalPrice;
}

export function calculateMaxBaseAssetAmountToTrade(
	amm: AMM,
	limit_price: BN
): [BN, PositionDirection] {
	const invariant = amm.sqrtK.mul(amm.sqrtK);

	const newBaseAssetReserveSquared = invariant
		.mul(MARK_PRICE_PRECISION)
		.mul(amm.pegMultiplier)
		.div(limit_price)
		.div(PEG_PRECISION);

	const newBaseAssetReserve = squareRootBN(
		newBaseAssetReserveSquared,
		AMM_RESERVE_PRECISION
	);

	if (newBaseAssetReserve.gt(amm.baseAssetReserve)) {
		return [
			newBaseAssetReserve.sub(amm.baseAssetReserve),
			PositionDirection.SHORT,
		];
	} else if (newBaseAssetReserve.lt(amm.baseAssetReserve)) {
		return [
			amm.baseAssetReserve.sub(newBaseAssetReserve),
			PositionDirection.LONG,
		];
	} else {
		console.log('tradeSize Too Small');
		return [new BN(0), PositionDirection.LONG];
	}
}
