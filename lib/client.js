/**
 * dsh-siyuan-archive — 客户端半场（浏览器 bundle）。
 *
 * 在 `settings.section` 槽位注册「思源归档」设置页：连接（地址 + 探测）、API token（只显示
 * 是否已配置）、归档目标（默认笔记本 / 路径 / 类型 / 标题模板）、权限（逐笔记本 r/w/d）、
 * 逐工具开关。全部读写都走宿主半场的 /siyuan-archive/api/* 路由；token 由宿主存入 dsh
 * 凭据库，页面永不回显。
 *
 * 本文件不经打包器：浏览器模块加载器提供 `react`，用 React.createElement 手写。
 */
// 注意：这个 id 必须与 package.json 的 name 完全一致（client-modules 按包名找注册）。
window.__ModuleLoader__.load({
	id: "dsh-siyuan-archive",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const e = React.createElement;
		const { useCallback, useEffect, useState } = React;

		//#region css
		const css = `
.dsa-root{display:flex;flex-direction:column;gap:14px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsa-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}
.dsa-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-base)}
.dsa-card > h3{font-size:13px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary)}
.dsa-row{display:flex;flex-direction:column;gap:4px}
.dsa-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsa-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsa-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsa-input{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:6px 9px;font-size:13px;line-height:18px;outline:none}
.dsa-input:focus{border-color:var(--dsw-alias-border-l2)}
.dsa-input[disabled]{opacity:.55;cursor:not-allowed}
.dsa-btn{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:999px;padding:3px 12px;font-size:12px;line-height:18px}
.dsa-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dsa-btn:disabled{opacity:.5;cursor:not-allowed}
.dsa-btn.primary{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.dsa-badge{font-size:11px;line-height:16px;border-radius:999px;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.dsa-badge.ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));border-color:currentColor}
.dsa-badge.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.dsa-msg{font-size:12px;line-height:18px}
.dsa-msg.err{color:var(--dsw-alias-state-error-primary)}
.dsa-msg.ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.dsa-probes{display:flex;flex-direction:column;gap:4px;font:var(--dsw-font-markdown-code-block-small,12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.dsa-probe{display:flex;gap:8px;align-items:baseline}
.dsa-probe .name{flex:none;color:var(--dsw-alias-label-secondary)}
.dsa-probe .detail{min-width:0;word-break:break-word;color:var(--dsw-alias-label-tertiary)}
.dsa-switch{position:relative;display:inline-block;flex:none;width:34px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l4);cursor:pointer;transition:background .15s ease}
.dsa-switch .dsa-switch-knob{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
.dsa-switch.on{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary))}
.dsa-switch.on .dsa-switch-knob{transform:translateX(14px)}
.dsa-switch:disabled{opacity:.5;cursor:not-allowed}
.dsa-perm-row{display:flex;align-items:center;gap:12px;padding:5px 0}
.dsa-perm-row + .dsa-perm-row{border-top:.5px solid var(--dsw-alias-border-l1)}
.dsa-perm-name{flex:1;min-width:0}
.dsa-perm-name .nm{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsa-perm-name .id{font:var(--dsw-font-markdown-code-block-small,12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-tertiary)}
.dsa-perm-cell{display:flex;flex-direction:column;align-items:center;gap:2px;flex:none}
.dsa-perm-cell .cap{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsa-perm-head{display:flex;align-items:center;gap:12px}
.dsa-perm-head .lbl-name{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsa-perm-head .lbl{flex:none;width:34px;font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dsa-perm-nb-head{display:flex;align-items:center;gap:8px}
.dsa-perm-expand{flex:none;font-size:11px;line-height:16px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsa-perm-expand:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dsa-perm-doc{display:flex;align-items:center;gap:12px;padding:3px 0;padding-left:14px}
.dsa-perm-doc + .dsa-perm-doc{border-top:.5px solid var(--dsw-alias-border-l1)}
.dsa-perm-doc-name{flex:1;min-width:0;display:flex;align-items:center;gap:6px}
.dsa-perm-doc-name .nm{min-width:0;font:var(--dsw-font-markdown-code-block-small,12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsa-perm-toggle{flex:none;width:16px;height:16px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:10px;line-height:16px;border-radius:4px;text-align:center}
.dsa-perm-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsa-perm-doc .cap{font-size:10px;line-height:12px;color:var(--dsw-alias-label-tertiary)}
.dsa-tool{display:flex;align-items:center;gap:10px;padding:3px 0;border-radius:8px;cursor:pointer}
.dsa-tool + .dsa-tool{border-top:.5px solid var(--dsw-alias-border-l1)}
.dsa-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-tool-text{display:flex;flex-direction:column;min-width:0;flex:1}
.dsa-tool .name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsa-tool .desc{font:var(--dsw-font-markdown-code-block-small,12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--dsw-alias-label-tertiary)}
.dsa-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:2px}
`;
		const tagId = "dsh-siyuan-archive/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-siyuan-archive";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region api
		const API_TIMEOUT_MS = 15000;
		async function api(method, body) {
			const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(API_TIMEOUT_MS) : undefined;
			let response;
			try {
				response = await fetch("/siyuan-archive/api/" + method, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body ?? {}),
					signal
				});
			} catch (error) {
				if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
					throw new Error("请求超时（" + API_TIMEOUT_MS / 1000 + " 秒），宿主没有响应");
				}
				throw error;
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (payload === null || typeof payload !== "object") throw new Error("宿主没有返回 JSON（HTTP " + response.status + "）");
			if (payload.ok !== true) throw new Error((payload.error && payload.error.message) || ("HTTP " + response.status));
			return payload.value;
		}
		//#endregion

		//#region 文案
		const CATEGORIES = ["需求", "方案", "报告", "数据", "演示", "纪要", "杂项"];
		const PERM_MODES = [
			{ key: "r", label: "读" },
			{ key: "w", label: "写" },
			{ key: "d", label: "删" }
		];
		const TOOL_LABELS = {
			siyuan_list_notebooks: "列出笔记本",
			siyuan_search: "全文检索",
			siyuan_read_doc: "读文档",
			siyuan_archive: "归档内容",
			siyuan_delete_block: "删除内容块",
			siyuan_remove_doc: "删除整篇文档"
		};
		//#endregion

		//#region 展示件
		function Message(props) {
			if (props.status === null || props.status === undefined) return null;
			return e("div", { className: "dsa-msg " + props.status.kind }, props.status.text);
		}
		function Note(props) {
			return e("p", { className: "dsa-note" }, props.children);
		}
		function Btn(props) {
			return e(
				"button",
				{ type: "button", className: "dsa-btn" + (props.primary === true ? " primary" : ""), disabled: props.disabled === true, onClick: props.onClick },
				props.label
			);
		}
		function Card(props) {
			return e(
				"div",
				{ className: "dsa-card" },
				e("div", { className: "dsa-inline" }, e("h3", null, props.title), props.header),
				e(Message, { status: props.status }),
				props.children
			);
		}
		function Switch(props) {
			return e(
				"button",
				{
					type: "button",
					role: "switch",
					"aria-checked": props.checked === true,
					"aria-label": props.label,
					className: "dsa-switch" + (props.checked === true ? " on" : ""),
					disabled: props.disabled === true,
					onClick: props.onToggle
				},
				e("span", { className: "dsa-switch-knob" })
			);
		}
		function ProbeList(props) {
			const probes = Array.isArray(props.probe.probes) ? props.probe.probes : [];
			return e(
				"div",
				{ className: "dsa-probes" },
				typeof props.probe.baseUrl === "string" && props.probe.baseUrl !== "" ? e(Note, null, "探测地址：" + props.probe.baseUrl) : null,
				probes.map((item, index) =>
					e(
						"div",
						{ className: "dsa-probe", key: "probe-" + index },
						e("span", { className: "name" }, (item.ok ? "✓ " : "✗ ") + item.label),
						e("span", { className: "detail" }, item.detail)
					)
				)
			);
		}
		function clone(value) {
			if (value === null || typeof value !== "object") return value;
			if (typeof structuredClone === "function") return structuredClone(value);
			return JSON.parse(JSON.stringify(value));
		}
		function toolsDraftFromState(state) {
			const tools = {};
			for (const entry of Array.isArray(state?.tools) ? state.tools : []) tools[entry.name] = entry.enabled === true;
			return tools;
		}
		function draftFromState(state) {
			return {
				baseUrl: state.config.baseUrl,
				defaultNotebook: state.config.defaultNotebook,
				archivePath: state.config.archivePath,
				category: state.config.category,
				titleTemplate: state.config.titleTemplate,
				permissions: clone(state.config.permissions) || {},
				tools: toolsDraftFromState(state)
			};
		}
		/** 由扁平 docs 列表（{id, hpath}）构建层级树；中间路径节点作为「文件夹」占位（无 id / hasDoc=false）。 */
		function buildDocTree(docs) {
			const root = { name: "", hpath: "", id: "", hasDoc: false, children: [] };
			const sorted = [...docs].sort((a, b) => String(a.hpath).localeCompare(String(b.hpath)));
			for (const doc of sorted) {
				const segs = String(doc.hpath).split("/").filter(Boolean);
				let node = root;
				let pathSoFar = "";
				for (let i = 0; i < segs.length; i++) {
					const seg = segs[i];
					pathSoFar = pathSoFar + "/" + seg;
					let child = node.children.find((c) => c.name === seg);
					if (child === undefined) {
						child = { name: seg, hpath: pathSoFar, id: "", hasDoc: false, children: [] };
						node.children.push(child);
					}
					node = child;
				}
				node.id = doc.id;
				node.hasDoc = true;
			}
			return root.children;
		}
		//#endregion

		//#region 设置页
		function SiYuanSection() {
			const [state, setState] = useState(null);
			const [draft, setDraft] = useState(null);
			const [notebooks, setNotebooks] = useState(null);
			const [tokenDraft, setTokenDraft] = useState("");
			const [messages, setMessages] = useState({});
			const [probe, setProbe] = useState(null);
			const [pending, setPending] = useState(null);
			const [docTrees, setDocTrees] = useState({});
			const [expanded, setExpanded] = useState({});

			const load = useCallback(async () => {
				try {
					const value = await api("getState");
					setState(value);
					setDraft(draftFromState(value));
				} catch (error) {
					setMessages((current) => ({ ...current, connection: { kind: "err", text: "读取配置失败：" + error.message } }));
				}
			}, []);

			useEffect(() => {
				load();
			}, [load]);

			useEffect(() => {
				if (state === null || draft === null || notebooks !== null || state.reachable !== true) return;
				let cancelled = false;
				api("listNotebooks", { baseUrl: draft.baseUrl, token: tokenDraft })
					.then((result) => {
						if (!cancelled) setNotebooks(result.notebooks);
					})
					.catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [state, notebooks]);

			const setMessage = (card, status) => setMessages((current) => ({ ...current, [card]: status }));
			const run = async (card, label, fn) => {
				setPending(card);
				setMessage(card, null);
				try {
					await fn();
				} catch (error) {
					setMessage(card, { kind: "err", text: label + "失败：" + error.message });
				} finally {
					setPending(null);
				}
			};

			const applyState = (value, card) => {
				setState(value);
				setDraft((current) => {
					if (current === null) return draftFromState(value);
					const patch = { baseUrl: value.config.baseUrl, defaultNotebook: value.config.defaultNotebook, archivePath: value.config.archivePath, category: value.config.category, titleTemplate: value.config.titleTemplate, permissions: clone(value.config.permissions) || {}, tools: toolsDraftFromState(value) };
					return { ...current, ...patch };
				});
			};

			const patchDraft = (patch) => setDraft((current) => (current === null ? current : { ...current, ...patch }));
			const flipTool = (name) => setDraft((current) => (current === null ? current : { ...current, tools: { ...current.tools, [name]: current.tools[name] !== true } }));
			const togglePerm = (notebookId, mode) =>
				setDraft((current) => {
					if (current === null) return current;
					const permissions = clone(current.permissions) || {};
					const entry = clone(permissions[notebookId]) || { r: false, w: false, d: false, docs: {} };
					entry[mode] = entry[mode] !== true;
					permissions[notebookId] = entry;
					return { ...current, permissions };
				});

			// 文档级开关 = 「最终是否可读写删」：开 = 继承到的有效权限，关 = 显式拒绝（收紧）。
			// 只有父级授予时才能点（否则禁用）；点关 = 显式拒绝，点开 = 清除拒绝恢复继承。
			const toggleDocDeny = (notebookId, hpath, mode, currentlyEffective) =>
				setDraft((current) => {
					if (current === null) return current;
					const permissions = clone(current.permissions) || {};
					const entry = clone(permissions[notebookId]) || { r: false, w: false, d: false, docs: {} };
					const docs = clone(entry.docs) || {};
					const node = clone(docs[hpath]) || {};
					node[mode] = currentlyEffective === true ? false : undefined;
					if (node.r === false || node.w === false || node.d === false) docs[hpath] = node;
					else delete docs[hpath];
					entry.docs = docs;
					permissions[notebookId] = entry;
					return { ...current, permissions };
				});

			const loadDocTree = async (notebookId) => {
				try {
					const result = await api("listDocTree", { notebook: notebookId, baseUrl: draft.baseUrl, token: tokenDraft });
					setDocTrees((current) => ({ ...current, [notebookId]: buildDocTree(Array.isArray(result.docs) ? result.docs : []) }));
				} catch (error) {
					setMessage("permissions", { kind: "err", text: "加载文档树失败：" + error.message });
				}
			};
			const toggleExpand = (notebookId, hpath) => {
				const key = hpath === undefined ? notebookId : notebookId + "|" + hpath;
				if (hpath === undefined && docTrees[notebookId] === undefined) loadDocTree(notebookId);
				setExpanded((current) => ({ ...current, [key]: !current[key] }));
			};

			const saveConnection = () => run("connection", "保存地址", async () => { const value = await api("updateConfig", { baseUrl: draft.baseUrl }); applyState(value); setMessage("connection", { kind: "ok", text: "地址已保存。" }); });
			const saveArchive = () => run("archive", "保存归档", async () => { const value = await api("updateConfig", { defaultNotebook: draft.defaultNotebook, archivePath: draft.archivePath, category: draft.category, titleTemplate: draft.titleTemplate }); applyState(value); setMessage("archive", { kind: "ok", text: "归档设置已保存。" }); });
			const saveTools = () => run("tools", "保存开关", async () => { const value = await api("updateConfig", { tools: draft.tools }); applyState(value); setMessage("tools", { kind: "ok", text: "工具开关已生效（不需要重启 dsh）。" }); });
			const savePermissions = () => run("permissions", "保存权限", async () => { const value = await api("updateConfig", { permissions: draft.permissions }); applyState(value); setMessage("permissions", { kind: "ok", text: "权限已保存（顶级授予自动继承到子级）。" }); });

			const saveToken = () => run("token", "保存 token", async () => { if (tokenDraft.trim() === "") throw new Error("token 为空"); const value = await api("setToken", { token: tokenDraft }); applyState(value); setTokenDraft(""); setMessage("token", { kind: "ok", text: "token 已存入宿主凭据库。" }); });
			const clearToken = () => run("token", "清除 token", async () => { const value = await api("clearToken"); applyState(value); setMessage("token", { kind: "ok", text: "已清除 token。" }); });

			const testConnection = () => run("connection", "连接测试", async () => { const result = await api("testConnection", { baseUrl: draft.baseUrl, token: tokenDraft }); setProbe(result); setMessage("connection", { kind: result.ok ? "ok" : "err", text: result.ok ? "连接正常，思源版本 " + result.version + "。" : "有探测项失败，详见下方。" }); });
			const loadNotebooks = () => run("archive", "加载笔记本", async () => { const result = await api("listNotebooks", { baseUrl: draft.baseUrl, token: tokenDraft }); setNotebooks(result.notebooks); setMessage("archive", { kind: "ok", text: "已加载 " + result.notebooks.length + " 个笔记本。" }); });

			if (state === null || draft === null) {
				return e("div", { className: "dsa-root" }, e(Message, { status: messages.connection }), e(Note, null, "正在读取配置…"));
			}

			const tools = Array.isArray(state.tools) ? state.tools : [];
			const dirty = {
				connection: draft.baseUrl !== state.config.baseUrl,
				archive:
					draft.defaultNotebook !== state.config.defaultNotebook ||
					draft.archivePath !== state.config.archivePath ||
					draft.category !== state.config.category ||
					draft.titleTemplate !== state.config.titleTemplate,
				permissions: JSON.stringify(draft.permissions) !== JSON.stringify(state.config.permissions),
				tools: tools.some((entry) => draft.tools[entry.name] !== entry.enabled)
			};
			const anyDirty = dirty.connection || dirty.archive || dirty.permissions || dirty.tools;
			const busy = { connection: pending === "connection", token: pending === "token", archive: pending === "archive", permissions: pending === "permissions", tools: pending === "tools" };

			const reachBadge = e("span", { className: "dsa-badge " + (state.reachable ? "ok" : "err") }, state.reachable ? "可达 · v" + (state.version || "?") : "不可达");
			const tokenSourceText = state.token.source === "env" ? "来自环境变量" : state.token.source === "credentials" ? "存在 dsh 凭据库" : state.token.source === "" ? "" : "来源 " + state.token.source;
			const tokenBadge = e(
				"span",
				{ className: "dsa-badge " + (state.token.configured ? "ok" : "") },
				state.token.configured ? "token 已配置" + (tokenSourceText === "" ? "" : " · " + tokenSourceText) + (state.token.writable ? " · 可在页面修改" : " · 页面不可改") : "token 未配置"
			);

			const notebookOptions = [{ id: "", name: "（未设置 · 工具调用时必须显式传 notebook）" }].concat(notebooks === null ? [] : notebooks.map((nb) => ({ id: nb.id, name: (nb.closed ? "[已关闭] " : "") + nb.name + " · " + nb.id })));
			const selectedNotebookKnown = notebookOptions.some((option) => option.id === draft.defaultNotebook);

			// 权限卡：显示「已加载的笔记本 ∪ 已配置但当前未加载的笔记本」，未配置的一律视为全拒。
			const permIds = new Set(Object.keys(draft.permissions || {}));
			for (const nb of notebooks === null ? [] : notebooks) permIds.add(nb.id);
			const permRows = Array.from(permIds).map((id) => {
				const loaded = (notebooks === null ? [] : notebooks).find((nb) => nb.id === id);
				const name = loaded ? (loaded.closed ? "[已关闭] " : "") + loaded.name : id;
				const entry = (draft.permissions && draft.permissions[id]) || { r: false, w: false, d: false };
				return { id, name, loaded: loaded !== undefined, entry };
			});
			permRows.sort((a, b) => (a.loaded === b.loaded ? 0 : a.loaded ? -1 : 1));

			// 递归渲染文档树：每个节点开关显示「最终是否可读写删」，父级未授予则禁用。
			const renderPermChildren = (nbId, children, parentEffective, depth) => {
				const out = [];
				for (const node of children) {
					const docsEntry = (draft.permissions && draft.permissions[nbId] && draft.permissions[nbId].docs && draft.permissions[nbId].docs[node.hpath]) || {};
					const effective = {
						r: parentEffective.r === true && docsEntry.r !== false,
						w: parentEffective.w === true && docsEntry.w !== false,
						d: parentEffective.d === true && docsEntry.d !== false
					};
					const hasChildren = node.children.length > 0;
					const key = nbId + "|" + node.hpath;
					const isOpen = expanded[key] === true;
					out.push(
						e(
							"div",
							{ className: "dsa-perm-doc", key: "doc-" + key, style: { paddingLeft: 14 + depth * 14 + "px" } },
							e(
								"span",
								{ className: "dsa-perm-doc-name" },
								hasChildren
									? e("button", { type: "button", className: "dsa-perm-toggle", onClick: () => toggleExpand(nbId, node.hpath) }, isOpen ? "▾" : "▸")
									: e("span", { className: "dsa-perm-toggle", style: { visibility: "hidden" } }, "▸"),
								e("span", { className: "nm", title: node.hpath }, node.name)
							),
							PERM_MODES.map((m) =>
								e(
									"div",
									{ className: "dsa-perm-cell", key: key + "-" + m.key },
									e(Switch, {
										label: node.name + " " + m.label,
										checked: effective[m.key] === true,
										disabled: busy.permissions || parentEffective[m.key] !== true,
										onToggle: () => toggleDocDeny(nbId, node.hpath, m.key, effective[m.key] === true)
									})
								)
							)
						)
					);
					if (isOpen && hasChildren) {
						const nested = renderPermChildren(nbId, node.children, effective, depth + 1);
						for (const el of nested) out.push(el);
					}
				}
				return out;
			};

			return e(
				"div",
				{ className: "dsa-root" },

				// ── 连接 ──
				e(
					Card,
					{ title: "连接", status: messages.connection, header: reachBadge },
					e(
						"div",
						{ className: "dsa-row" },
						e("label", { className: "dsa-label", htmlFor: "dsa-base-url" }, "思源地址（API base URL）"),
						e("input", { id: "dsa-base-url", className: "dsa-input", type: "text", value: draft.baseUrl, placeholder: "http://127.0.0.1:6806", disabled: busy.connection, onChange: (event) => patchDraft({ baseUrl: event.target.value }) }),
						e(Note, null, "以 dsh 进程所在机器的视角访问它；默认 127.0.0.1:6806 即本机思源。")
					),
					e("div", { className: "dsa-actions" }, e(Btn, { label: "保存地址", primary: true, disabled: busy.connection || !dirty.connection, onClick: saveConnection }), e(Btn, { label: "测试连接", disabled: busy.connection, onClick: testConnection }), dirty.connection ? e(Btn, { label: "撤销", disabled: busy.connection, onClick: () => patchDraft({ baseUrl: state.config.baseUrl }) }) : null),
					probe === null ? null : e(ProbeList, { probe })
				),

				// ── API token ──
				e(
					Card,
					{ title: "API token", status: messages.token, header: tokenBadge },
					e(
						"div",
						{ className: "dsa-row" },
						e("label", { className: "dsa-label", htmlFor: "dsa-token" }, "API token"),
						e(
							"div",
							{ className: "dsa-inline" },
							e("input", { id: "dsa-token", className: "dsa-input", type: "password", style: { flex: "1 1 220px" }, value: tokenDraft, placeholder: "思源 → 设置 → 关于 → API token", disabled: busy.token || state.token.writable !== true, onChange: (event) => setTokenDraft(event.target.value) }),
							e(Btn, { label: "保存 token", primary: true, disabled: busy.token || state.token.writable !== true, onClick: saveToken }),
							e(Btn, { label: "清除", disabled: busy.token || state.token.configured !== true || state.token.writable !== true, onClick: clearToken })
						),
						state.token.writable !== true ? e(Note, null, "当前 token 来自只读来源（环境变量或部署配置），页面无法覆盖。") : e(Note, null, "保存后写入宿主凭据库；轮换 token 无需重启。")
					)
				),

				// ── 归档 ──
				e(
					Card,
					{ title: "归档", status: messages.archive, header: e("div", { className: "dsa-actions" }, e(Btn, { label: notebooks === null ? "加载笔记本" : "刷新笔记本", disabled: busy.archive, onClick: loadNotebooks }), e(Btn, { label: "保存归档", primary: true, disabled: busy.archive || !dirty.archive, onClick: saveArchive }), dirty.archive ? e(Btn, { label: "撤销", disabled: busy.archive, onClick: () => patchDraft({ defaultNotebook: state.config.defaultNotebook, archivePath: state.config.archivePath, category: state.config.category, titleTemplate: state.config.titleTemplate }) }) : null) },
					e("div", { className: "dsa-row" }, e("label", { className: "dsa-label", htmlFor: "dsa-notebook" }, "归档目标笔记本"), e("select", { id: "dsa-notebook", className: "dsa-input", value: draft.defaultNotebook, disabled: busy.archive, onChange: (event) => patchDraft({ defaultNotebook: event.target.value }) }, selectedNotebookKnown ? null : e("option", { value: draft.defaultNotebook }, notebooks === null ? draft.defaultNotebook + "（已保存 · 点「加载笔记本」显示名称）" : draft.defaultNotebook + "（不在当前列表中）"), notebookOptions.map((option) => e("option", { key: "nb-" + option.id, value: option.id }, option.name)))),
					e("div", { className: "dsa-row" }, e("label", { className: "dsa-label", htmlFor: "dsa-archive-path" }, "归档根路径（人类路径，以 / 开头）"), e("input", { id: "dsa-archive-path", className: "dsa-input", type: "text", value: draft.archivePath, placeholder: "/（空 = 笔记本根）", disabled: busy.archive, onChange: (event) => patchDraft({ archivePath: event.target.value }) }), e(Note, null, "归档文档生成在 <归档路径>/<年-月>/<类型>/<标题> 下。")),
					e("div", { className: "dsa-row" }, e("label", { className: "dsa-label", htmlFor: "dsa-category" }, "默认类型"), e("select", { id: "dsa-category", className: "dsa-input", value: draft.category, disabled: busy.archive, onChange: (event) => patchDraft({ category: event.target.value }) }, CATEGORIES.map((c) => e("option", { key: "cat-" + c, value: c }, c)))),
					e("div", { className: "dsa-row" }, e("label", { className: "dsa-label", htmlFor: "dsa-title-template" }, "标题模板"), e("input", { id: "dsa-title-template", className: "dsa-input", type: "text", value: draft.titleTemplate, placeholder: "{date}_{time}_{topic}_{desc}", disabled: busy.archive, onChange: (event) => patchDraft({ titleTemplate: event.target.value }) }), e(Note, null, "占位符 {date}{time}{topic}{desc}{category}；缺省 = 日期_时间_主题_描述。"))
				),

				// ── 权限 ──
				e(
					Card,
					{ title: "权限", status: messages.permissions, header: e("div", { className: "dsa-actions" }, e(Btn, { label: "保存权限", primary: true, disabled: busy.permissions || !dirty.permissions, onClick: savePermissions }), dirty.permissions ? e(Btn, { label: "撤销", disabled: busy.permissions, onClick: () => patchDraft({ permissions: clone(state.config.permissions) || {} }) }) : null) },
					e("div", { className: "dsa-perm-head" }, e("span", { className: "lbl-name" }, "笔记本 / 文档"), PERM_MODES.map((m) => e("span", { className: "lbl", key: "head-" + m.key }, m.label))),
					permRows.length === 0
						? e(Note, null, "尚未加载笔记本，或没有配置过权限。点「归档」卡里的「加载笔记本」后再来勾选。")
						: permRows.map((row) => {
								const nbEffective = { r: row.entry.r === true, w: row.entry.w === true, d: row.entry.d === true };
								const nodes = [
									e(
										"div",
										{ className: "dsa-perm-row", key: "perm-" + row.id },
										e(
											"div",
											{ className: "dsa-perm-name" },
											e("div", { className: "nm" }, row.name),
											e(
												"div",
												{ className: "dsa-inline" },
												e("span", { className: "id" }, row.id),
												e("button", { type: "button", className: "dsa-perm-expand", onClick: () => toggleExpand(row.id) }, expanded[row.id] ? "收起文档" : "展开文档")
											)
										),
										PERM_MODES.map((m) =>
											e(
												"div",
												{ className: "dsa-perm-cell", key: row.id + "-" + m.key },
												e(Switch, { label: row.name + " " + m.label, checked: row.entry[m.key] === true, disabled: busy.permissions, onToggle: () => togglePerm(row.id, m.key) })
											)
										)
									)
								];
								if (expanded[row.id] === true) {
									const tree = docTrees[row.id];
									if (tree === undefined) {
										nodes.push(e(Note, { key: "doc-loading-" + row.id }, "加载文档树…"));
									} else if (tree.length === 0) {
										nodes.push(e(Note, { key: "doc-empty-" + row.id }, "该笔记本下没有子文档。"));
									} else {
										const nested = renderPermChildren(row.id, tree, nbEffective, 0);
										for (const el of nested) nodes.push(el);
									}
								}
								return nodes;
							}),
					e(Note, null, "未勾选的笔记本默认全拒（读/写/删皆拒）。笔记本级开关 = 授予，自动继承到子文档；子级开关显示「最终是否可读写删」，关闭 = 显式拒绝（收紧），父级未授予时子级开关置灰不可开。")
				),

				// ── 工具开关 ──
				e(
					Card,
					{ title: "工具开关", status: messages.tools, header: e("span", { className: "dsa-note" }, "已启用 " + tools.filter((entry) => draft.tools[entry.name] === true).length + " / 共 " + tools.length + " 个") },
					tools.map((entry) => {
						const hasLabel = typeof TOOL_LABELS[entry.name] === "string";
						const label = hasLabel ? TOOL_LABELS[entry.name] : entry.name;
						const on = draft.tools[entry.name] === true;
						return e(
							"div",
							{ className: "dsa-tool", key: "tool-" + entry.name, role: "switch", "aria-checked": on, onClick: () => (busy.tools ? null : flipTool(entry.name)) },
							e(Switch, { label: label, checked: on, disabled: busy.tools, onToggle: () => flipTool(entry.name) }),
							e("div", { className: "dsa-tool-text" }, e("div", { className: "name" }, label), hasLabel ? e("div", { className: "desc" }, entry.name) : null)
						);
					}),
					e("div", { className: "dsa-actions" }, e(Btn, { label: "保存开关", primary: true, disabled: busy.tools || !dirty.tools, onClick: saveTools }), dirty.tools ? e(Btn, { label: "撤销", disabled: busy.tools, onClick: () => patchDraft({ tools: toolsDraftFromState(state) }) }) : null)
				),

				// ── 页脚 ──
				e("div", { className: "dsa-footer" }, e(Btn, { label: "重新读取", disabled: pending !== null, onClick: () => run("connection", "重新读取", load) }), e(Note, null, anyDirty ? "有未保存的改动，「重新读取」会丢弃它们。" : "所有改动都已保存。"))
			);
		}
		//#endregion

		//#region plugin
		const inject = ["slots"];
		function apply(ctx) {
			const slots = ctx.slots ?? (typeof ctx.get === "function" ? ctx.get("slots") : undefined);
			if (slots === undefined) return;
			slots.inject("settings.section", () =>
				slots.register({ name: "settings.section", id: "siyuan-archive", order: 40, label: "思源归档" }, SiYuanSection)
			);
		}
		exports.inject = inject;
		exports.apply = apply;
		exports.internals = { CATEGORIES, PERM_MODES, TOOL_LABELS };
		//#endregion

		return module.exports;
	}
});
