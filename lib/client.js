window.__ModuleLoader__.load({
  id: "dsh-web-search-custom",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let jsxRuntime = require("react/jsx-runtime");
    let jsx = jsxRuntime.jsx;
    // 官方表单原语（同一份实现驱动官方 web-search / agent-loop / sub-shell 设置卡）：
    // SettingsForm 负责只读提示 + 字段区 + 保存按钮，SettingsValueField 负责
    // 标签/覆盖胶囊/重置/输入框/hint。本插件不重复实现卡壳，也不再自带 CSS。
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

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
      // 只读部署下不发起写入（官方 SettingsFormModel.save 同款守卫：宿主不是唯一
      // 闸门时，客户端也不该把一次只读点击变成一次注定被拒的写）。
      if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
      if (this.snapshotOf().writable === false) return;
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
    /** 插件卸载/命名空间停服时释放 scope 订阅（对齐官方卡的 form.dispose）。 */
    CardForm.prototype.dispose = function () {
      this._unsubscribe();
      this.listeners.clear();
    };

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
    CustomSearchController.prototype.dispose = function () { this.form.dispose(); };

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

    /** SettingsForm 需要的框架文案（官方卡同款键集合）。 */
    function formLabels(t) {
      return {
        unavailable: t("unavailable"),
        readOnly: t("readOnly"),
        saveFailed: t("saveFailed"),
        save: t("save"),
        saving: t("saving")
      };
    }

    /**
     * 插件页本卡片的两个视图（plugins.item 的 ownerProps.view）：
     * - "summary"：列表卡描述区 / 详情页副标题 —— 只返回一行文案（框架画卡壳与标题）。
     * - "page"（或未传）：详情页配置区 —— 返回 SettingsForm 本体，不重复画卡壳。
     */
    function CustomSearchCard(props) {
      const t = props.t;
      if (props.view === "summary") return t("card.description");
      const state = props.useCustomSearch((snapshot) => snapshot);
      const disabled = !state.writable;
      return jsx(primitives.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: FIELD_VIEWS.map((view) => {
          const field = state[view.key];
          return jsx(primitives.SettingsValueField, {
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
      "unavailable": "该插件当前未加载，暂时无法配置。",
      "save": "保存",
      "saving": "保存中…",
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
      "unavailable": "This plugin is not loaded, so it cannot be configured right now.",
      "save": "Save",
      "saving": "Saving…",
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

    // 0.1.7 起 settingsScope 服务已移除，设置作用域改由 configForms.get(ns) 提供
    // （ConfigFormController：getSnapshot/set/unset/subscribe 同名同形，快照多出
    // base/revision/mode 字段——本卡只读 status/value/user/writable/base，全兼容）。
    const inject = ["slots", "locale", "configForms"];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-web-search-custom: dictionaries");
      // 0.1.7：configForms.get(ns) 返回 ConfigFormController（旧 settingsScope.bind
      // 的同形替代）；宿主未服务该命名空间时 status 停在 unavailable，卡片自己只读。
      const controller = new CustomSearchController(ctx.configForms.get(NS));
      ctx.effect(() => () => controller.dispose(), "dsh-web-search-custom: form subscription");
      // 0.1.7 slots.inject 契约：callback 是「返回 disposer 的普通函数」（0.1.5 的
      // generator + yield register 形态已废弃）；官方 settings-web-search /
      // agent-loop / subagent / shell 与本仓参考插件 prompt-injector 同为箭头形态。
      // whileServed：宿主开始服务本命名空间（ns 出现在 describe 视图）才注册，
      // 命名空间消失（插件停用）时自动摘除。
      // label thunk：列表页/详情页标题随 locale 现读；id = 宿主行 id = 命名空间。
      ctx.effect(
        () => ctx.configForms.whileServed([NS], () => ctx.slots.inject("plugins.item",
          () => ctx.slots.register({
            name: "plugins.item",
            id: NS,
            order: 50,
            label: () => t("card.title"),
            locale: NS,
            inject: () => controller.inject()
          }, CustomSearchCard)
        )),
        "dsh-web-search-custom: card registration"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
