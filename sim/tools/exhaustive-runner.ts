/**
 * Battle Simulator exhaustive runner.
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * @license MIT
 */

import {ObjectReadWriteStream} from '../../lib/streams';
import {Dex, toID} from '../dex';
import {PRNG, PRNGSeed} from '../prng';
import {RandomPlayerAI} from './random-player-ai';
import {AIOptions, Runner} from './runner';

interface Pools {
	pokemon: Pool;
	items: Pool;
	abilities: Pool;
	moves: Pool;
}

export interface ExhaustiveRunnerOptions {
	format: string;
	cycles?: number;
	prng?: PRNG | PRNGSeed | null;
	log?: boolean;
	maxGames?: number;
	maxFailures?: number;
	dual?: boolean | 'debug';
}

export class ExhaustiveRunner {
	static readonly DEFAULT_CYCLES = 1;
	static readonly MAX_FAILURES = 10;

	// TODO: Add triple battles once supported by the AI.
	static readonly FORMATS = [
		'gen8customgame', 'gen8doublescustomgame',
		'gen7customgame', 'gen7doublescustomgame',
		'gen6customgame', 'gen6doublescustomgame',
		'gen5customgame', 'gen5doublescustomgame',
		'gen4customgame', 'gen4doublescustomgame',
		'gen3customgame', 'gen3doublescustomgame',
		'gen2customgame',
		'gen1customgame',
	];

	private readonly format: string;
	private readonly cycles: number;
	private readonly prng: PRNG;
	private readonly log: boolean;
	private readonly maxGames?: number;
	private readonly maxFailures?: number;
	private readonly dual: boolean | 'debug';

	private failures: number;
	private games: number;

	constructor(options: ExhaustiveRunnerOptions) {
		this.format = options.format;
		this.cycles = options.cycles || ExhaustiveRunner.DEFAULT_CYCLES;
		this.prng = (options.prng && !Array.isArray(options.prng)) ?
			options.prng : new PRNG(options.prng);
		this.log = !!options.log;
		this.maxGames = options.maxGames;
		this.maxFailures = options.maxFailures || ExhaustiveRunner.MAX_FAILURES;
		this.dual = options.dual || false;

		this.failures = 0;
		this.games = 0;
	}

	async run() {
		const dex = Dex.forFormat(this.format);
		dex.loadData(); // FIXME: This is required for `dex.gen` to be set properly...

		const seed = this.prng.seed;
		const pools = this.createPools(dex);
		const createAI = (s: ObjectReadWriteStream<string>, o: AIOptions) => new CoordinatedPlayerAI(s, o, pools);
		const generator = new TeamGenerator(dex, this.prng, pools, ExhaustiveRunner.getSignatures(dex, pools));

		do {
			this.games++;
			try {
				const is4P = dex.getFormat(this.format).gameType === 'multi';
				// We run these sequentially instead of async so that the team generator
				// and the AI can coordinate usage properly.
				await new Runner({
					prng: this.prng,
					p1options: {team: generator.generate(), createAI},
					p2options: {team: generator.generate(), createAI},
					p3options: is4P ? {team: generator.generate(), createAI} : undefined,
					p4options: is4P ? {team: generator.generate(), createAI} : undefined,
					format: this.format,
					dual: this.dual,
					error: true,
				}).run();

				if (this.log) this.logProgress(pools);
			} catch (err) {
				this.failures++;
				console.error(
					`\n\nRun \`node tools/simulate exhaustive --cycles=${this.cycles} ` +
						`--format=${this.format} --seed=${seed.join()}\`:\n`,
					err
				);
			}
		} while ((!this.maxGames || this.games < this.maxGames) &&
					(!this.maxFailures || this.failures < this.maxFailures) &&
					generator.exhausted < this.cycles);

		return this.failures;
	}

	private createPools(dex: typeof Dex): Pools {
		return {
			pokemon: new Pool(ExhaustiveRunner.onlyValid(dex.gen, dex.data.Pokedex, p => dex.getSpecies(p),
				(_, p) => (p.name !== 'Pichu-Spiky-eared' && p.name.substr(0, 8) !== 'Pikachu-')), this.prng),
			items: new Pool(ExhaustiveRunner.onlyValid(dex.gen, dex.data.Items, i => dex.getItem(i)), this.prng),
			abilities: new Pool(ExhaustiveRunner.onlyValid(dex.gen, dex.data.Abilities, a => dex.getAbility(a)), this.prng),
			moves: new Pool(ExhaustiveRunner.onlyValid(dex.gen, dex.data.Moves, m => dex.getMove(m),
				m => (m !== 'struggle' && (m === 'hiddenpower' || m.substr(0, 11) !== 'hiddenpower'))), this.prng),
		};
	}

	private logProgress(p: Pools) {
		// `\r` = return to the beginning of the line
		// `\x1b[k` (`\e[K`) = clear all characters from cursor position to EOL
		if (this.games) process.stdout.write('\r\x1b[K');
		// Deliberately don't print a `\n` character so that we can overwrite
		process.stdout.write(
			`[${this.format}] P:${p.pokemon} I:${p.items} A:${p.abilities} M:${p.moves} = ${this.games}`
		);
	}

	private static getSignatures(dex: typeof Dex, pools: Pools): Map<string, {item: string, move?: string}[]> {
		const signatures = new Map();
		for (const id of pools.items.possible) {
			const item = dex.data.Items[id];
			if (item.megaEvolves) {
				const pokemon = toID(item.megaEvolves);
				const combo = {item: id};
				let combos = signatures.get(pokemon);
				if (!combos) {
					combos = [];
					signatures.set(pokemon, combos);
				}
				combos.push(combo);
			} else if (item.itemUser) {
				for (const user of item.itemUser) {
					const pokemon = toID(user);
					const combo: {item: string, move?: string} = {item: id};
					if (item.zMoveFrom) combo.move = toID(item.zMoveFrom);
					let combos = signatures.get(pokemon);
					if (!combos) {
						combos = [];
						signatures.set(pokemon, combos);
					}
					combos.push(combo);
				}
			}
		}
		return signatures;
	}

	private static onlyValid<T>(
		gen: number, obj: {[key: string]: T}, getter: (k: string) => AnyObject,
		additional?: (k: string, v: AnyObject) => boolean, nonStandard?: boolean
	) {
		return Object.keys(obj).filter(k => {
			const v = getter(k);
			return v.gen <= gen &&
				(!v.isNonstandard || !!nonStandard) &&
				(!additional || additional(k, v));
		});
	}
}

// Generates random teams of pokemon suitable for use in custom games (ie. without team
// validation). Coordinates with the CoordinatedPlayerAI below through Pools to ensure as
// many different options as possible get exercised in battle.
class TeamGenerator {
	// By default, the TeamGenerator generates sets completely at random which unforunately means
	// certain signature combinations (eg. Mega Stone/Z Moves which only work for specific Pokemon)
	// are unlikely to be chosen. To combat this, we keep a mapping of these combinations and some
	// fraction of the time when we are generating sets for these particular Pokemon we give them
	// the combinations they need to exercise the simulator more thoroughly.
	static readonly COMBO = 0.5;

	private readonly dex: typeof Dex;
	private readonly prng: PRNG;
	private readonly pools: Pools;
	private readonly signatures: Map<string, {item: string, move?: string}[]>;
	private readonly natures: readonly string[];

	constructor(
		dex: typeof Dex, prng: PRNG | PRNGSeed | null, pools: Pools,
		signatures: Map<string, {item: string, move?: string}[]>
	) {
		this.dex = dex;
		this.prng = prng && !Array.isArray(prng) ? prng : new PRNG(prng);
		this.pools = pools;
		this.signatures = signatures;

		this.natures = Object.keys(this.dex.data.Natures);
	}

	get exhausted() {
		const exhausted = [this.pools.pokemon.exhausted, this.pools.moves.exhausted];
		if (this.dex.gen >= 2) exhausted.push(this.pools.items.exhausted);
		if (this.dex.gen >= 3) exhausted.push(this.pools.abilities.exhausted);
		return Math.min.apply(null, exhausted);
	}

	generate() {
		const team: PokemonSet[] = [];
		for (const pokemon of this.pools.pokemon.next(6)) {
			const species = this.dex.getSpecies(pokemon);
			const randomEVs = () => this.prng.next(253);
			const randomIVs = () => this.prng.next(32);

			let item;
			const moves = [];
			const combos = this.signatures.get(species.id);
			if (combos && this.prng.next() > TeamGenerator.COMBO) {
				const combo = this.prng.sample(combos);
				item = combo.item;
				if (combo.move) moves.push(combo.move);
			} else {
				item = this.dex.gen >= 2 ? this.pools.items.next() : '';
			}

			team.push({
				name: species.baseSpecies,
				species: species.name,
				gender: species.gender,
				item,
				ability: this.dex.gen >= 3 ? this.pools.abilities.next() : 'None',
				moves: moves.concat(...this.pools.moves.next(4 - moves.length)),
				evs: {
					hp: randomEVs(),
					atk: randomEVs(),
					def: randomEVs(),
					spa: randomEVs(),
					spd: randomEVs(),
					spe: randomEVs(),
				},
				ivs: {
					hp: randomIVs(),
					atk: randomIVs(),
					def: randomIVs(),
					spa: randomIVs(),
					spd: randomIVs(),
					spe: randomIVs(),
				},
				nature: this.prng.sample(this.natures),
				level: this.prng.next(50, 100),
				happiness: this.prng.next(256),
				shiny: this.prng.randomChance(1, 1024),
			});
		}
		return team;
	}
}
