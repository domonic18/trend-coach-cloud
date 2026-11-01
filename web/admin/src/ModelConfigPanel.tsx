import { useEffect, useState, type FormEvent } from 'react'
import {
  createLlmConfig,
  deleteLlmConfig,
  getAsrConfig,
  listLlmConfigs,
  patchAsrConfig,
  patchLlmConfig,
  setDefaultLlmConfig,
  testAsrConfig,
  testLlmConfig,
  type LlmConfigInput,
} from './api'
import type { AsrModelConfig, AsrProtocol, LlmModelConfig, LlmPurpose } from './types'
import { Field, formatTime, Notice } from './ui'

interface LlmForm {
  configId: string | null
  name: string
  provider: string
  baseUrl: string
  model: string
  purpose: LlmPurpose
  apiKey: string
  isActive: boolean
  isDefault: boolean
}

const EMPTY_FORM: LlmForm = {
  configId: null,
  name: '',
  provider: 'openai',
  baseUrl: '',
  model: '',
  purpose: 'content',
  apiKey: '',
  isActive: true,
  isDefault: false,
}

export function ModelConfigPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [configs, setConfigs] = useState<LlmModelConfig[]>([])
  const [asr, setAsr] = useState<AsrModelConfig | null>(null)
  const [form, setForm] = useState<LlmForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const fail = (cause: unknown): void => {
    if (cause instanceof Error && 'status' in cause && (cause as { status: number }).status === 401) {
      onUnauthorized()
      return
    }
    setError(cause instanceof Error ? cause.message : '操作失败')
    setMessage(null)
  }

  const load = async (): Promise<void> => {
    try {
      const [llms, asrConfig] = await Promise.all([listLlmConfigs(), getAsrConfig()])
      setConfigs(llms)
      setAsr(asrConfig)
    } catch (cause) {
      fail(cause)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const refresh = async (text: string): Promise<void> => {
    setMessage(text)
    setError(null)
    await load()
  }

  return (
    <div className="stack">
      <Notice error={error} message={message} />

      <section className="card">
        <div className="spread">
          <div>
            <h2>模型配置</h2>
            <p className="hint">
              key 加密存库、只回显掩码；保存后立即生效。content 用于章节/知识点/文章生成，embedding 用于检索与发布建索引（必须 1024 维）。
            </p>
          </div>
          <button onClick={() => setForm(form === null ? { ...EMPTY_FORM } : null)}>
            {form === null ? '新增模型' : '取消'}
          </button>
        </div>

        {form === null ? null : (
          <LlmFormCard
            form={form}
            onChange={setForm}
            onSaved={async text => {
              setForm(null)
              await refresh(text)
            }}
            onError={fail}
          />
        )}

        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>用途</th>
              <th>模型</th>
              <th>密钥</th>
              <th>状态</th>
              <th>最近测试</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {configs.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">尚未配置模型</td>
              </tr>
            ) : null}
            {configs.map(config => (
              <LlmRow
                key={`${config.configId}:${config.isDefault}:${config.isActive}:${config.updatedAt}`}
                config={config}
                onEdit={() => setForm({
                  configId: config.configId,
                  name: config.name,
                  provider: config.provider,
                  baseUrl: config.baseUrl,
                  model: config.model,
                  purpose: config.purpose,
                  apiKey: '',
                  isActive: config.isActive,
                  isDefault: config.isDefault,
                })}
                onChanged={refresh}
                onError={fail}
              />
            ))}
          </tbody>
        </table>
      </section>

      {asr === null ? null : (
        <AsrCard key={asr.updatedAt} config={asr} onChanged={refresh} onError={fail} />
      )}
    </div>
  )
}

function LlmFormCard({
  form,
  onChange,
  onSaved,
  onError,
}: {
  form: LlmForm
  onChange: (form: LlmForm) => void
  onSaved: (text: string) => Promise<void>
  onError: (cause: unknown) => void
}) {
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      const input: LlmConfigInput = {
        name: form.name.trim(),
        provider: form.provider.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        purpose: form.purpose,
        isActive: form.isActive,
        isDefault: form.isDefault,
        ...(form.apiKey === '' ? {} : { apiKey: form.apiKey }),
      }
      if (form.configId === null) {
        await createLlmConfig(input)
        await onSaved('模型已新增')
      } else {
        await patchLlmConfig(form.configId, input)
        await onSaved('模型已更新')
      }
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  const valid = form.name.trim() !== ''
    && form.provider.trim() !== ''
    && form.baseUrl.trim() !== ''
    && form.model.trim() !== ''

  return (
    <form className="card inline-form" autoComplete="off" onSubmit={event => void submit(event)}>
      <div className="row">
        <Field label="名称">
          <input value={form.name} onChange={event => onChange({ ...form, name: event.target.value })} />
        </Field>
        <Field label="用途">
          <select
            value={form.purpose}
            onChange={event => onChange({ ...form, purpose: event.target.value as LlmPurpose })}
          >
            <option value="content">content（内容生成）</option>
            <option value="embedding">embedding（检索索引）</option>
          </select>
        </Field>
        <Field label="供应商">
          <input value={form.provider} onChange={event => onChange({ ...form, provider: event.target.value })} />
        </Field>
      </div>
      <div className="row">
        <Field label="Base URL">
          <input
            className="wide"
            placeholder="https://api.example.com/v1"
            value={form.baseUrl}
            onChange={event => onChange({ ...form, baseUrl: event.target.value })}
          />
        </Field>
        <Field label="模型">
          <input value={form.model} onChange={event => onChange({ ...form, model: event.target.value })} />
        </Field>
      </div>
      <div className="row">
        <Field label={form.configId === null ? 'API Key' : 'API Key（留空保留原密钥）'}>
          <input
            className="wide"
            type="password"
            autoComplete="new-password"
            value={form.apiKey}
            onChange={event => onChange({ ...form, apiKey: event.target.value })}
          />
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={event => onChange({ ...form, isActive: event.target.checked })}
          />
          启用
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={event => onChange({ ...form, isDefault: event.target.checked })}
          />
          设为默认
        </label>
        <button type="submit" disabled={busy || !valid}>
          {form.configId === null ? '新增' : '保存'}
        </button>
      </div>
    </form>
  )
}

function LlmRow({
  config,
  onEdit,
  onChanged,
  onError,
}: {
  config: LlmModelConfig
  onEdit: () => void
  onChanged: (text: string) => Promise<void>
  onError: (cause: unknown) => void
}) {
  const [busy, setBusy] = useState(false)

  const run = async (text: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      await onChanged(text)
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = async (): Promise<void> => {
    await run(config.isActive ? '模型已停用' : '模型已启用', () =>
      patchLlmConfig(config.configId, { isActive: !config.isActive }))
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`删除模型「${config.name}」？`)) return
    await run('模型已删除', () => deleteLlmConfig(config.configId))
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await testLlmConfig(config.configId)
      await onChanged(result.status === 'success' ? `测试通过：${result.detail}` : `测试失败：${result.detail}`)
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr>
      <td>
        <strong>{config.name}</strong>
        <div className="muted">{config.provider}</div>
      </td>
      <td>{config.purpose === 'content' ? '内容生成' : '检索索引'}</td>
      <td>
        <div>{config.model}</div>
        <div className="muted">{config.baseUrl}</div>
      </td>
      <td className="muted">{config.apiKeyMasked ?? '未配置'}</td>
      <td>
        {config.isDefault ? <span className="badge badge-published">默认</span> : null}
        {config.isActive ? null : <span className="badge badge-draft">已停用</span>}
      </td>
      <td className="muted">
        {config.lastTestStatus === null ? '—' : (
          <>
            <span className={config.lastTestStatus === 'success' ? 'ok' : 'bad'}>
              {config.lastTestStatus === 'success' ? '通过' : '失败'}
            </span>
            <div>{formatTime(config.lastTestedAt)}</div>
            {config.lastTestError === null ? null : <div>{config.lastTestError}</div>}
          </>
        )}
      </td>
      <td>
        <div className="row">
          <button className="ghost" disabled={busy} onClick={() => void test()}>测试</button>
          <button
            className="ghost"
            disabled={busy || config.isDefault || !config.isActive}
            onClick={() => void run('已设为默认', () => setDefaultLlmConfig(config.configId))}
          >
            设默认
          </button>
          <button className="ghost" disabled={busy} onClick={onEdit}>编辑</button>
          <button className="ghost" disabled={busy} onClick={() => void toggleActive()}>
            {config.isActive ? '停用' : '启用'}
          </button>
          <button className="ghost" disabled={busy} onClick={() => void remove()}>删除</button>
        </div>
      </td>
    </tr>
  )
}

function AsrCard({
  config,
  onChanged,
  onError,
}: {
  config: AsrModelConfig
  onChanged: (text: string) => Promise<void>
  onError: (cause: unknown) => void
}) {
  const [form, setForm] = useState({
    provider: config.provider,
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: '',
    enabled: config.enabled,
  })
  const [busy, setBusy] = useState(false)

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    try {
      await patchAsrConfig({
        provider: form.provider.trim(),
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        enabled: form.enabled,
        ...(form.apiKey === '' ? {} : { apiKey: form.apiKey }),
      })
      setForm({ ...form, apiKey: '' })
      await onChanged('ASR 配置已保存')
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await testAsrConfig()
      await onChanged(result.status === 'success' ? `测试通过：${result.detail}` : `测试失败：${result.detail}`)
    } catch (cause) {
      onError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>ASR 渠道</h2>
      <p className="hint">
        视频建课的转写使用此配置；未启用或未配置 key 时转写阶段返回 503，其他阶段不受影响。
      </p>
      <form className="stack" autoComplete="off" onSubmit={event => void save(event)}>
        <div className="row">
          <Field label="供应商">
            <input
              value={form.provider}
              onChange={event => setForm({ ...form, provider: event.target.value })}
            />
          </Field>
          <Field label="协议">
            <select
              value={form.protocol}
              onChange={event => setForm({ ...form, protocol: event.target.value as AsrProtocol })}
            >
              <option value="minimax">minimax（/v1/speech_to_text）</option>
              <option value="openai">openai（/audio/transcriptions）</option>
            </select>
          </Field>
          <Field label="模型">
            <input value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} />
          </Field>
        </div>
        <div className="row">
          <Field label="Base URL">
            <input
              className="wide"
              value={form.baseUrl}
              onChange={event => setForm({ ...form, baseUrl: event.target.value })}
            />
          </Field>
          <Field label={`API Key（当前：${config.apiKeyMasked ?? '未配置'}）`}>
            <input
              className="wide"
              type="password"
              autoComplete="new-password"
              placeholder="留空保留原密钥"
              value={form.apiKey}
              onChange={event => setForm({ ...form, apiKey: event.target.value })}
            />
          </Field>
        </div>
        <div className="row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={event => setForm({ ...form, enabled: event.target.checked })}
            />
            启用
          </label>
          <button type="submit" disabled={busy || form.baseUrl.trim() === '' || form.model.trim() === ''}>
            保存
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => void test()}>
            测试连接
          </button>
          <span className="muted">
            {config.lastTestStatus === null
              ? '尚未测试'
              : `${config.lastTestStatus === 'success' ? '上次通过' : '上次失败'} · ${formatTime(config.lastTestedAt)}`}
          </span>
        </div>
        {config.lastTestError === null ? null : <p className="hint">{config.lastTestError}</p>}
      </form>
    </section>
  )
}
