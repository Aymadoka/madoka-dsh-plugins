// madoka-dsh-github-mcp — browser half: token form for the bridge row.
//
// Registers `plugins.row.config` for `madoka-dsh-github-mcp#madoka-github-mcp`.
// The form writes the token into that row's `headers.Authorization` and never
// renders the secret back: it only shows configured / unconfigured.
//
// Plain script on purpose (no build step): React comes from the browser module
// table, theme is inherited via unstyled native controls.
window.__ModuleLoader__.load({
  id: 'madoka-dsh-github-mcp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'madokaGithubToken';
    const ROW_KEY = 'madoka-dsh-github-mcp#madoka-github-mcp';

    const en = {
      configured: 'A token is configured.',
      unconfigured: 'No token configured; the bridge falls back to GITHUB_PERSONAL_ACCESS_TOKEN.',
      unavailable: 'This row cannot be configured right now.',
      tokenLabel: 'GitHub personal access token',
      tokenHint: 'Saved into this row’s headers. The value is stored as plain text in the profile — prefer the GITHUB_PERSONAL_ACCESS_TOKEN environment variable for shared machines.',
      save: 'Save',
      saving: 'Saving…',
      clear: 'Remove token',
      saved: 'Saved. The GitHub tools reconnect with the new token.',
      cleared: 'Removed. The bridge falls back to GITHUB_PERSONAL_ACCESS_TOKEN.',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      emptyError: 'Paste a token first.',
    };
    const zh = {
      configured: '已配置 token。',
      unconfigured: '未配置 token；桥接会回退读 GITHUB_PERSONAL_ACCESS_TOKEN 环境变量。',
      unavailable: '该行当前无法配置。',
      tokenLabel: 'GitHub 个人访问令牌',
      tokenHint: '保存到本行的 headers 里。该值以明文存放在 profile 中——共用机器请优先用 GITHUB_PERSONAL_ACCESS_TOKEN 环境变量。',
      save: '保存',
      saving: '保存中…',
      clear: '移除 token',
      saved: '已保存。GitHub 工具会用新 token 重连。',
      cleared: '已移除。桥接回退读 GITHUB_PERSONAL_ACCESS_TOKEN 环境变量。',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      emptyError: '请先粘贴 token。',
    };

    /** The row's effective config, from whichever snapshot shape the host hands us. */
    function rowConfig(form) {
      const state = form && form.state;
      const candidates = [
        state && state.value,
        state && state.config,
        state,
        form && form.value,
        form && form.config,
      ];
      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object') return candidate;
      }
      return {};
    }

    function currentHeaders(form) {
      const headers = rowConfig(form).headers;
      return headers && typeof headers === 'object' ? headers : {};
    }

    function isConfigured(form) {
      const auth = currentHeaders(form).Authorization;
      return typeof auth === 'string' && auth.length > 0;
    }

    /**
     * The revision fence for a write: `scope.mutate(ops, revision)` takes the
     * revision the scope snapshot carries (SettingsFormModel.save passes
     * `this.baseline?.revision`, read from `scope.getSnapshot()`). Read it
     * defensively from whichever shape the page host hands us; an absent fence
     * still lets the Host arbitrate the write.
     */
    function revisionOf(form) {
      const state = form && form.state;
      const candidates = [
        state && state.revision,
        state && state.value && state.value.revision,
        form && form.revision,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === 'number') return candidate;
      }
      return undefined;
    }

    function TokenPage(props) {
      const { t, view, form } = props;
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [failed, setFailed] = React.useState(false);
      if (!form) return h('p', null, t('unavailable'));
      if (view === 'summary') {
        return h('span', null, t(isConfigured(form) ? 'configured' : 'unconfigured'));
      }
      async function run(ops, doneKey) {
        setBusy(true);
        setNotice('');
        setFailed(false);
        try {
          // Falsy means the write did not land: SettingsFormModel.save treats it
          // as `if (!landed) failed`, so match that rather than testing for false.
          const landed = await form.mutate(ops, revisionOf(form));
          if (!landed) {
            setFailed(true);
            setNotice(t('saveFailed'));
          } else {
            setDraft('');
            setNotice(t(doneKey));
          }
        } catch (error) {
          setFailed(true);
          setNotice(error && error.message ? error.message : t('saveFailed'));
        } finally {
          setBusy(false);
        }
      }
      function onSave() {
        const token = draft.trim();
        if (token === '') {
          setFailed(true);
          setNotice(t('emptyError'));
          return;
        }
        const headers = { ...currentHeaders(form), Authorization: 'Bearer ' + token };
        run([{ op: 'set', path: ['headers'], value: headers }], 'saved');
      }
      function onClear() {
        run([{ op: 'unset', path: ['headers', 'Authorization'] }], 'cleared');
      }
      return h('div', null,
        h('p', null, t(isConfigured(form) ? 'configured' : 'unconfigured')),
        h('label', { style: { display: 'block', margin: '8px 0 4px' } }, t('tokenLabel')),
        h('input', {
          type: 'password',
          value: draft,
          disabled: busy,
          autoComplete: 'off',
          placeholder: 'Paste token here',
          onChange: (event) => {
            setDraft(event.target.value);
            setNotice('');
            setFailed(false);
          },
          style: { width: '100%', boxSizing: 'border-box' },
        }),
        h('p', { style: { opacity: 0.75 } }, t('tokenHint')),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', disabled: busy || draft.trim() === '', onClick: onSave },
            busy ? t('saving') : t('save')),
          h('button', { type: 'button', disabled: busy || !isConfigured(form), onClick: onClear },
            t('clear'))),
        notice ? h('p', { role: failed ? 'alert' : 'status' }, (failed ? t('saveFailed') + ' ' : '') + notice) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'madoka-github-mcp: dictionaries',
        );
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
        }, TokenPage));
      },
    };
  },
});
