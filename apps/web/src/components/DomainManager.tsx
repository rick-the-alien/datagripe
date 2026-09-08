import type { Domain } from "@datagripe/contracts";
import { useEffect, useState } from "react";
import { openSyncPanel, readDomainManagerParams } from "../app/viewPanels";
import {
	domainColourVar,
	selectDomains,
	selectTags,
	useDomainsStore,
} from "../stores/domains";
import { useConnectionsStore } from "../stores/runtime";
import { RailHelp, TabShell } from "./TabRail";

/**
 * The domain manager (docs/spec/domains.md "Domain manager").
 *
 * One row per domain: swatch, name, description, object count, `include
 * data`, delete. Deleting shows the count that is about to become
 * untagged and asks — a domain with 30 tags is 30 decisions, and losing
 * them to a stray click would be the worst kind of quiet.
 *
 * A tab rather than a modal, following the rest of the app: it survives
 * navigation, can sit beside the tree it is describing, and does not
 * trap focus (docs/brand/mocks/datasource-selector.html "New datasource
 * is a tab").
 */

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8];

function countFor(tags: Record<string, string>, domainId: string): number {
	return Object.values(tags).filter((id) => id === domainId).length;
}

export function DomainManager(props: { params?: unknown }) {
	const connectionRef = readDomainManagerParams(props.params);
	const connectionName = useConnectionsStore(
		(state) =>
			state.connections.find((entry) => entry.id === connectionRef)?.name ??
			connectionRef,
	);
	const domains = useDomainsStore(selectDomains(connectionRef));
	const tags = useDomainsStore(selectTags(connectionRef));
	const upsert = useDomainsStore((state) => state.upsert);
	const remove = useDomainsStore((state) => state.remove);
	const load = useDomainsStore((state) => state.load);

	const [name, setName] = useState("");
	const [colour, setColour] = useState(1);
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (connectionRef !== "") {
			void load(connectionRef);
		}
	}, [load, connectionRef]);

	const create = async () => {
		setError(null);
		setBusy(true);
		try {
			await upsert(connectionRef, {
				name: name.trim(),
				colour,
				description: "",
				includeData: false,
				sortOrder: domains.length,
			});
			setName("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not create it");
		} finally {
			setBusy(false);
		}
	};

	const update = async (domain: Domain, changes: Partial<Domain>) => {
		setError(null);
		try {
			await upsert(connectionRef, { ...domain, ...changes });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save it");
		}
	};

	if (connectionRef === "") {
		return (
			<div className="dg-form dg-scroll">
				<div className="dg-form-body">
					<h3 className="dg-form-title">Domains</h3>
					<p className="dg-form-lead">No datasource selected.</p>
				</div>
			</div>
		);
	}

	const help = (
		<RailHelp>
			<p>
				A domain is the label the catalog does not carry: which part of the
				product a table or routine belongs to. It crosses schemas, and it
				changes nothing about what a query can touch.
			</p>
			<dl>
				<dt>colour</dt>
				<dd>
					Shows as a rail down the left of the object's row in the tree, so a
					mis-tagged table is visible without switching views.
				</dd>
				<dt>objects</dt>
				<dd>
					How many are tagged. An object has at most one domain — tagging it
					again moves it.
				</dd>
				<dt>data</dt>
				<dd>
					Export <code>INSERT</code> statements alongside the DDL. For reference
					and config tables whose contents are part of the schema. A table with
					no primary key is refused, because row order would churn the diff on
					every export.
				</dd>
			</dl>
			<p>
				To tag: right-click an object in the tree and pick <code>domain</code>.
				Ctrl-click builds a selection first, so you can filter the tree and tag
				the matches in one go. Everything untagged shows in its own bucket at
				the bottom of the grouped tree — that count is the drift a
				hand-maintained script could never show.
			</p>
			<button
				type="button"
				className="dg-rail-link"
				onClick={() => openSyncPanel(connectionRef, connectionName)}
			>
				sync → write the dump and commit it
			</button>
		</RailHelp>
	);

	return (
		<TabShell
			className="dg-form-body dg-form-wide dg-domain-manager"
			rail={[{ id: "help", label: "help", node: help }]}
		>
			<h3 className="dg-form-title">Domains</h3>
			<p className="dg-form-lead">
				A label for the dimension the catalog does not carry. One domain per
				object; everything else is untagged, and the tree says how many.
			</p>

			<div className="dg-domain-new">
				<input
					value={name}
					placeholder="new domain name"
					aria-label="New domain name"
					onChange={(event) => setName(event.target.value.toLowerCase())}
					onKeyDown={(event) => {
						if (event.key === "Enter" && name.trim() !== "") {
							void create();
						}
					}}
				/>
				{/* Toggle buttons rather than a radio group: the swatch is a
					    colour, and a radio input cannot carry one without a label
					    that would take more room than the control. */}
				<div className="dg-domain-slots">
					{SLOTS.map((slot) => (
						<button
							key={slot}
							type="button"
							aria-pressed={colour === slot}
							aria-label={`Colour ${slot}`}
							className={
								colour === slot
									? "dg-domain-slot dg-domain-slot-on"
									: "dg-domain-slot"
							}
							style={{ background: domainColourVar(slot) }}
							onClick={() => setColour(slot)}
						/>
					))}
				</div>
				<button
					type="button"
					disabled={busy || name.trim() === ""}
					onClick={() => void create()}
				>
					add
				</button>
			</div>

			{error !== null && <div className="dg-modal-error">{error}</div>}

			<table className="dg-domain-table">
				<thead>
					<tr>
						<th>colour</th>
						<th>name</th>
						<th>description</th>
						<th>objects</th>
						<th title="Export INSERT statements alongside the DDL">data</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{domains.length === 0 && (
						<tr>
							<td colSpan={6} className="dg-tree-note">
								no domains yet — everything is untagged
							</td>
						</tr>
					)}
					{domains.map((domain) => {
						const count = countFor(tags, domain.id);
						return (
							<tr key={domain.id}>
								<td>
									<div className="dg-domain-slots">
										{SLOTS.map((slot) => (
											<button
												key={slot}
												type="button"
												aria-label={`Set ${domain.name} to colour ${slot}`}
												className={
													domain.colour === slot
														? "dg-domain-slot dg-domain-slot-on"
														: "dg-domain-slot"
												}
												style={{ background: domainColourVar(slot) }}
												onClick={() => void update(domain, { colour: slot })}
											/>
										))}
									</div>
								</td>
								<td>
									<input
										value={domain.name}
										aria-label={`Rename ${domain.name}`}
										onChange={(event) =>
											void update(domain, {
												name: event.target.value.toLowerCase(),
											})
										}
									/>
								</td>
								<td>
									<input
										value={domain.description}
										placeholder="—"
										aria-label={`Describe ${domain.name}`}
										onChange={(event) =>
											void update(domain, {
												description: event.target.value,
											})
										}
									/>
								</td>
								<td className="dg-domain-count">{count}</td>
								<td>
									<input
										type="checkbox"
										checked={domain.includeData}
										aria-label={`Export data for ${domain.name}`}
										onChange={(event) =>
											void update(domain, {
												includeData: event.target.checked,
											})
										}
									/>
								</td>
								<td>
									{confirming === domain.id ? (
										<span className="dg-domain-confirm">
											{/* The count is the point: a domain with 30 tags
												    is 30 decisions. */}
											untag {count}?
											<button
												type="button"
												className="dg-context-danger"
												onClick={() => {
													void remove(connectionRef, domain.id);
													setConfirming(null);
												}}
											>
												delete
											</button>
											<button type="button" onClick={() => setConfirming(null)}>
												keep
											</button>
										</span>
									) : (
										<button
											type="button"
											onClick={() => setConfirming(domain.id)}
										>
											delete
										</button>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>

			<p className="dg-modal-note">
				A domain is a label, not a permission. It changes nothing about what a
				query can touch.
			</p>
		</TabShell>
	);
}
