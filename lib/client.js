window.__ModuleLoader__.load({
  id: "dsh-web-search-custom",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let jsxRuntime = require("react/jsx-runtime");
    let jsx = jsxRuntime.jsx;
    let jsxs = jsxRuntime.jsxs;
    let useState = react.useState;
    let useSyncExternalStore = react.useSyncExternalStore;

    // ---- minimal snapshot store (own implementation: zero extra imports) ----
    function createStore(init) {
      let state = init;
      const listeners = new Set();
      return {
        getSnapshot() { return state; },
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
        set(next) { state = next; listeners.forEach((fn) => fn()); }
      };
    }
    function useStore(store, selector) {
      return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()));
    }

    // ---- card form model (own staging + revision-fenced scope writes) ----
    function textField(field) {
      return {
        field,
        format: (value) => typeof value === "string" ? value : "",
        parse: (text) => {
          const trimmed = text.trim();
          return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
        }
      };
    }
    function numberField(field) {
      return {
        field,
        format: (value) => typeof value === "number" ? String(value) : "",
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === "") return { kind: "clear" };
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) ? { kind: "set", value: parsed } : undefined;
        }
      };
    }

    function CardForm(scope, specs) {
      this.scope = scope;
      this.specs = new Map();
      specs.forEach((spec) => { this.specs.set(spec.field, spec); });
      this.staged = new Map();
      this.listeners = new Set();
      this.saving = false;
      this.failed = false;
      const self = this;
      this._unsubscribe = scope.subscribe(() => { self.publish(); });
    }
    CardForm.prototype.bind = function (project) {
      const self = this;
      const store = createStore(project());
      this.listeners.add(() => { store.set(project()); });
      return store;
    };
    CardForm.prototype.shell = function () {
      const snapshot = this.scope.getSnapshot();
      const plan = this.plan();
      return {
        available: snapshot.status === "ready",
        writable: snapshot.writable === true,
        dirty: plan.length > 0,
        invalid: plan.some((item) => item.run === undefined),
        saving: this.saving,
        failed: this.failed
      };
    };
    CardForm.prototype.field = function (field) {
      const staged = this.staged.get(field);
      const spec = this.spec(field);
      if (staged === undefined) {
        return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false };
      }
      const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
      return {
        text: staged.text,
        overridden: write !== undefined && write.kind === "set",
        invalid: write === undefined
      };
    };
    CardForm.prototype.actions = function () {
      const self = this;
      return {
        edit: (field, text) => self.stage(field, { text, clear: false }),
        resetField: (field) => self.stage(field, { text: self.spec(field).format(self.baseValue(field)), clear: true }),
        save: () => self.save(),
        discard: () => {
          if (self.staged.size === 0 && !self.failed) return;
          self.staged.clear();
          self.failed = false;
          self.publish();
        }
      };
    };
    CardForm.prototype.save = async function () {
      const plan = this.plan();
      const writes = [];
      plan.forEach((item) => { if (item.run !== undefined) writes.push(item.run); });
      if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
      this.saving = true;
      this.failed = false;
      this.publish();
      let landed = true;
      for (let i = 0; i < writes.length; i += 1) {
        const ok = await writes[i]();
        if (!ok) landed = false;
      }
      if (landed) this.staged.clear();
      this.saving = false;
      this.failed = !landed;
      this.publish();
    };
    CardForm.prototype.plan = function () {
      const self = this;
      const plan = [];
      this.staged.forEach((staged, field) => {
        const spec = self.spec(field);
        if (staged.clear) {
          if (self.stored(field)) plan.push({ field, run: () => self.clear(field) });
          return;
        }
        if (staged.text === spec.format(self.sectionValue(field))) return;
        const write = spec.parse(staged.text);
        if (write === undefined) plan.push({ field, run: undefined });
        else if (write.kind === "clear") plan.push({ field, run: () => self.clear(field) });
        else plan.push({ field, run: () => self.store(field, write.value) });
      });
      return plan;
    };
    CardForm.prototype.clear = async function (field) {
      await this.scope.unset(field);
      return !this.stored(field);
    };
    CardForm.prototype.store = async function (field, value) {
      await this.scope.set(field, value);
      const user = this.userLayer();
      return user === undefined ? false : user[field] === value;
    };
    CardForm.prototype.stage = function (field, edit) {
      this.staged.set(field, edit);
      this.failed = false;
      this.publish();
    };
    CardForm.prototype.spec = function (field) {
      const spec = this.specs.get(field);
      if (spec === undefined) throw new Error("plugin card has no field " + field);
      return spec;
    };
    CardForm.prototype.snapshotOf = function () { return this.scope.getSnapshot(); };
    CardForm.prototype.sectionValue = function (field) {
      const value = this.snapshotOf().value;
      return value === undefined ? undefined : value[field];
    };
    CardForm.prototype.baseValue = function (field) {
      const base = this.snapshotOf().base;
      return base === undefined ? undefined : base[field];
    };
    CardForm.prototype.userLayer = function () { return this.snapshotOf().user; };
    CardForm.prototype.stored = function (field) {
      const user = this.userLayer();
      return user !== undefined && Object.prototype.hasOwnProperty.call(user, field);
    };
    CardForm.prototype.publish = function () { this.listeners.forEach((fn) => fn()); };

    // ---- card controller ----
    const FIELD_KEYS = [
      "api", "url", "apiKey", "maxResults", "method", "body", "headers", "authHeader", "authScheme",
      "timeoutMs", "resultsPath", "urlField", "titleField", "snippetField", "publishedField"
    ];
    function CustomSearchController(scope) {
      const self = this;
      this.form = new CardForm(scope, [
        textField("api"), textField("url"), textField("apiKey"), numberField("maxResults"),
        textField("method"), textField("body"), textField("headers"),
        textField("authHeader"), textField("authScheme"), numberField("timeoutMs"),
        textField("resultsPath"), textField("urlField"), textField("titleField"),
        textField("snippetField"), textField("publishedField")
      ]);
      this.store = this.form.bind(() => self.projection());
    }
    CustomSearchController.prototype.projection = function () {
      const shell = this.form.shell();
      const result = {};
      Object.keys(shell).forEach((key) => { result[key] = shell[key]; });
      FIELD_KEYS.forEach((key) => { result[key] = this.form.field(key); });
      return result;
    };
    CustomSearchController.prototype.inject = function () {
      const actions = this.form.actions();
      const result = { hooks: { customSearch: this.store } };
      Object.keys(actions).forEach((key) => { result[key] = actions[key]; });
      return result;
    };


    // ---- official plugin-card styling (copied from @deepseek-ai/dsh-client-ui-settings-plugins) ----
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const FIELD_VIEWS = [
      { key: "api", labelKey: "field.api", hintKey: "hint.api" },
      { key: "url", labelKey: "field.url", hintKey: "hint.url" },
      { key: "apiKey", labelKey: "field.apiKey", hintKey: "hint.apiKey" },
      { key: "maxResults", labelKey: "field.maxResults", hintKey: "hint.maxResults", numeric: true },
      { key: "method", labelKey: "field.method", hintKey: "hint.method" },
      { key: "body", labelKey: "field.body", hintKey: "hint.body" },
      { key: "headers", labelKey: "field.headers", hintKey: "hint.headers" },
      { key: "authHeader", labelKey: "field.authHeader", hintKey: "hint.authHeader" },
      { key: "authScheme", labelKey: "field.authScheme", hintKey: "hint.authScheme" },
      { key: "timeoutMs", labelKey: "field.timeoutMs", hintKey: "hint.timeoutMs", numeric: true },
      { key: "resultsPath", labelKey: "field.resultsPath", hintKey: "hint.resultsPath" },
      { key: "urlField", labelKey: "field.urlField", hintKey: "hint.fieldMap" },
      { key: "titleField", labelKey: "field.titleField", hintKey: "hint.fieldMap" },
      { key: "snippetField", labelKey: "field.snippetField", hintKey: "hint.fieldMap" },
      { key: "publishedField", labelKey: "field.publishedField", hintKey: "hint.fieldMap" }
    ];
    const css$2 = ".At1oFq_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.At1oFq_field+.At1oFq_field{border-top:1px solid var(--dsw-alias-border-l2)}.At1oFq_head{align-items:center;gap:8px;display:flex}.At1oFq_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.At1oFq_badges{align-items:center;gap:8px;display:inline-flex}.At1oFq_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.At1oFq_badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}.At1oFq_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}.At1oFq_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.At1oFq_reset:disabled{cursor:default}.At1oFq_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.At1oFq_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.At1oFq_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.At1oFq_inputInvalid{border-color:var(--dsw-alias-label-error);}.At1oFq_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.At1oFq_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}";
    const tagId$2 = "dsh-web-search-custom/fields.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-web-search-custom";
      tag.dataset.pluginCss = tagId$2;
      tag.textContent = css$2;
      document.head.appendChild(tag);
    }
    var fields_module_css_default = {
			"input": "At1oFq_input",
			"field": "At1oFq_field",
			"head": "At1oFq_head",
			"label": "At1oFq_label",
			"inputInvalid": "At1oFq_inputInvalid",
			"invalid": "At1oFq_invalid",
			"badges": "At1oFq_badges",
			"badgeMuted": "At1oFq_badgeMuted",
			"badge": "At1oFq_badge",
			"hint": "At1oFq_hint",
			"reset": "At1oFq_reset"
		};
    const css$1 = ".YyYd_a_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.YyYd_a_card:hover{border-color:var(--dsw-alias-label-dimmed)}.YyYd_a_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.YyYd_a_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.YyYd_a_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.YyYd_a_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.YyYd_a_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.YyYd_a_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.YyYd_a_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.YyYd_a_chevronOpen{transform:rotate(180deg)}.YyYd_a_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.YyYd_a_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}.YyYd_a_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.YyYd_a_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.YyYd_a_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}.YyYd_a_discard,.YyYd_a_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.YyYd_a_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.YyYd_a_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.YyYd_a_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.YyYd_a_discard:disabled,.YyYd_a_save:disabled{opacity:.4;cursor:default}.YyYd_a_discard:focus-visible,.YyYd_a_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}";
    const tagId$1 = "dsh-web-search-custom/PluginCard.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-web-search-custom";
      tag.dataset.pluginCss = tagId$1;
      tag.textContent = css$1;
      document.head.appendChild(tag);
    }
    var PluginCard_module_css_default = {
			"discard": "YyYd_a_discard",
			"header": "YyYd_a_header",
			"pending": "YyYd_a_pending",
			"name": "YyYd_a_name",
			"body": "YyYd_a_body",
			"failed": "YyYd_a_failed",
			"save": "YyYd_a_save",
			"chevronOpen": "YyYd_a_chevronOpen",
			"chevron": "YyYd_a_chevron",
			"cardOpen": "YyYd_a_cardOpen",
			"readOnly": "YyYd_a_readOnly",
			"description": "YyYd_a_description",
			"card": "YyYd_a_card",
			"headText": "YyYd_a_headText",
			"footer": "YyYd_a_footer"
		};
    function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
    function ValueField(props) {
      return jsxs("div", { className: fields_module_css_default.field, children: [
        jsxs("div", { className: fields_module_css_default.head, children: [
          jsx("label", { className: fields_module_css_default.label, htmlFor: props.id, children: props.label }),
          props.overridden ? jsxs("span", { className: fields_module_css_default.badges, children: [
            jsx("span", { className: fields_module_css_default.badge, children: props.overriddenLabel }),
            jsx("button", { type: "button", className: fields_module_css_default.reset, disabled: props.disabled, onClick: props.onReset, children: props.resetLabel })
          ] }) : null
        ] }),
        jsx("input", {
          id: props.id,
          className: props.invalid ? fields_module_css_default.inputInvalid : fields_module_css_default.input,
          type: "text",
          inputMode: props.numeric === true ? "numeric" : undefined,
          ...(props.invalid ? { "aria-invalid": true } : {}),
          value: props.text,
          placeholder: props.placeholder ?? "",
          disabled: props.disabled,
          onChange: (event) => { props.onEdit(event.target.value); }
        }),
        jsx("p", { className: props.invalid ? fields_module_css_default.invalid : fields_module_css_default.hint, children: props.invalid ? props.invalidLabel : props.hint })
      ] });
    }
    function PluginCard(props) {
      const pair = useState(false);
      const open = pair[0];
      const setOpen = pair[1];
      const state = props.state;
      if (!state.available) return null;
      const title = props.t(props.titleKey);
      const blocked = !state.dirty || state.invalid || state.saving;
      return jsxs("li", { className: clsx(PluginCard_module_css_default.card, open && PluginCard_module_css_default.cardOpen), children: [
        jsxs("button", {
          type: "button",
          className: PluginCard_module_css_default.header,
          "aria-expanded": open,
          "aria-label": props.t(open ? "collapse" : "expand") + ": " + title,
          onClick: () => { setOpen(!open); },
          children: [
            jsxs("span", { className: PluginCard_module_css_default.headText, children: [
              jsx("span", { className: PluginCard_module_css_default.name, children: title }),
              jsx("span", { className: PluginCard_module_css_default.description, children: props.t(props.descriptionKey) })
            ] }),
            state.dirty ? jsx("span", { className: PluginCard_module_css_default.pending, children: props.t("unsaved") }) : null,
            jsx(primitives.IconChevronDownOutline14, { className: clsx(PluginCard_module_css_default.chevron, open && PluginCard_module_css_default.chevronOpen) })
          ]
        }),
        open ? jsxs("div", { className: PluginCard_module_css_default.body, children: [
          !state.writable ? jsx("p", { className: PluginCard_module_css_default.readOnly, role: "status", children: props.t("readOnly") }) : null,
          props.children,
          jsxs("div", { className: PluginCard_module_css_default.footer, children: [
            state.failed ? jsx("p", { className: PluginCard_module_css_default.failed, role: "status", children: props.t("saveFailed") }) : null,
            jsx("button", { type: "button", className: PluginCard_module_css_default.discard, disabled: !state.dirty || state.saving, onClick: props.onDiscard, children: props.t("discard") }),
            jsx("button", { type: "button", className: PluginCard_module_css_default.save, disabled: blocked, onClick: props.onSave, children: props.t(state.saving ? "saving" : "save") })
          ] })
        ] }) : null
      ] });
    }
    function CustomSearchCard(props) {
      const state = props.useCustomSearch((snapshot) => snapshot);
      const t = props.t;
      if (!state.available) return null;
      const disabled = !state.writable;
      return jsx(PluginCard, {
        t,
        titleKey: "card.title",
        descriptionKey: "card.description",
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: FIELD_VIEWS.map((view) => {
          const field = state[view.key];
          return jsx(ValueField, {
            key: view.key,
            id: "plugin-config-web-search-custom-" + view.key,
            label: t(view.labelKey),
            hint: t(view.hintKey),
            overriddenLabel: t("overridden"),
            resetLabel: t("reset"),
            invalidLabel: t("invalid"),
            numeric: view.numeric === true,
            disabled,
            ...field,
            onEdit: (text) => { props.edit(view.key, text); },
            onReset: () => { props.resetField(view.key); }
          });
        })
      });
    }
    // ---- locales ----
    const NS = "web-search-custom";
    const zh = {
      "card.title": "自定义搜索（web-search-custom）",
      "card.description": "出厂默认接 AnySearch 统一搜索：不填 API key 走匿名免费档，填了就走该 key 的配额；也可切 generic 档对接 SearXNG 等任意 JSON 接口。",
      "unsaved": "未保存",
      "expand": "展开",
      "collapse": "收起",
      "save": "保存",
      "saving": "保存中…",
      "discard": "放弃",
      "saveFailed": "保存未生效，请检查填写内容",
      "readOnly": "该设置为只读（当前连接不可写）",
      "overridden": "已覆盖",
      "reset": "重置",
      "invalid": "请输入有效值",
      "field.api": "接口档位（api）",
      "hint.api": "auto（默认，按 URL 主机名判定）/ anysearch（AnySearch 专用档）/ generic（通用 JSON 档）",
      "field.url": "搜索 URL",
      "hint.url": "anysearch 档：填 https://api.anysearch.com/v1/search；generic 档支持 {query}（已编码）/ {queryRaw}（原始）/ {apiKey} 占位符，GET 且无 {query} 时自动补 q= 参数",
      "field.apiKey": "API Key（留空 = 免 key 匿名档）",
      "hint.apiKey": "anysearch 档：留空则完全不发鉴权头（匿名免费额度）；填了发 Authorization: Bearer <key>",
      "field.maxResults": "结果条数上限",
      "hint.maxResults": "anysearch 档发送 max_results，取本值与调用方上限的较小者，并夹在 1–10",
      "field.method": "请求方法（仅 generic）",
      "hint.method": "GET 或 POST；anysearch 档固定 POST",
      "field.body": "POST body 模板",
      "hint.body": "支持 {query} / {apiKey} 占位符",
      "field.headers": "额外请求头（JSON）",
      "hint.headers": '例如 {"X-Custom":"1"}，留空为 {}',
      "field.authHeader": "鉴权请求头名（仅 generic）",
      "hint.authHeader": "默认 Authorization；anysearch 档固定 Authorization",
      "field.authScheme": "鉴权 scheme（仅 generic）",
      "hint.authScheme": "默认 Bearer；anysearch 档固定 Bearer",
      "field.timeoutMs": "超时（毫秒）",
      "hint.timeoutMs": "单次请求超时，默认 30000",
      "field.resultsPath": "结果数组路径（仅 generic）",
      "hint.resultsPath": "JSON 点路径，默认 results；anysearch 档固定 data.results",
      "field.urlField": "URL 字段",
      "field.titleField": "标题字段",
      "field.snippetField": "摘要字段",
      "field.publishedField": "发布日期字段",
      "hint.fieldMap": "结果字段名映射（仅 generic；SearXNG：url/title/content/publishedDate）"
    };
    const en = {
      "card.title": "Custom search (web-search-custom)",
      "card.description": "Ships pointed at the AnySearch unified API: leave the API key empty for the anonymous free tier, or set a key to use that key's quota. Switch to the generic profile for SearXNG or any other JSON endpoint.",
      "unsaved": "Unsaved",
      "expand": "Expand",
      "collapse": "Collapse",
      "save": "Save",
      "saving": "Saving…",
      "discard": "Discard",
      "saveFailed": "Save did not land; check your input",
      "readOnly": "Read-only in this session (not writable over the current connection)",
      "overridden": "Overridden",
      "reset": "Reset",
      "invalid": "Enter a valid value",
      "field.api": "API profile",
      "hint.api": "auto (default; decided by URL host) / anysearch (AnySearch POST API) / generic (any JSON endpoint)",
      "field.url": "Search URL",
      "hint.url": "anysearch: use https://api.anysearch.com/v1/search. generic: supports {query} (encoded) / {queryRaw} (verbatim) / {apiKey}; GET without {query} appends q=",
      "field.apiKey": "API key (empty = keyless anonymous tier)",
      "hint.apiKey": "anysearch: empty sends NO Authorization header (anonymous free tier); set it to send Authorization: Bearer <key>",
      "field.maxResults": "Max results",
      "hint.maxResults": "anysearch sends max_results = min(this value, caller limit), clamped to 1-10",
      "field.method": "Request method (generic)",
      "hint.method": "GET or POST; the anysearch profile always uses POST",
      "field.body": "POST body template",
      "hint.body": "Supports {query} / {apiKey} placeholders",
      "field.headers": "Extra headers (JSON)",
      "hint.headers": 'e.g. {"X-Custom":"1"}; empty = {}',
      "field.authHeader": "Auth header name (generic)",
      "hint.authHeader": "Default Authorization; the anysearch profile always uses Authorization",
      "field.authScheme": "Auth scheme (generic)",
      "hint.authScheme": "Default Bearer; empty sends the key raw (anysearch always uses Bearer)",
      "field.timeoutMs": "Timeout (ms)",
      "hint.timeoutMs": "Per-request timeout, default 30000",
      "field.resultsPath": "Results array path (generic)",
      "hint.resultsPath": "Dot path into the JSON, default results; the anysearch profile always reads data.results",
      "field.urlField": "URL field",
      "field.titleField": "Title field",
      "field.snippetField": "Snippet field",
      "field.publishedField": "Published-date field",
      "hint.fieldMap": "Result field mapping (generic only; SearXNG: url/title/content/publishedDate)"
    };

    const inject = ["slots", "locale", "settingsScope", "connection", "remote"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-web-search-custom: dictionaries");
      const scope = ctx.settingsScope.bind({ namespace: NS });
      const controller = new CustomSearchController(scope);
      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register({
          name: "settings.plugin.item",
          key: NS,
          locale: NS,
          inject: () => controller.inject()
        }, CustomSearchCard);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

