import { DeleteOutlined, EditOutlined, ExperimentOutlined, PlusOutlined, StarOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  App,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useState } from 'react'
import {
  createLlmConfig,
  deleteLlmConfig,
  getAiBindings,
  getAiHealth,
  getAsrConfig,
  listLlmConfigs,
  patchAsrConfig,
  patchLlmConfig,
  putAiBinding,
  setDefaultLlmConfig,
  testAsrConfig,
  testLlmConfig,
  type LlmConfigInput,
} from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { errorText, formatDateTime, formatIso, formatPricePer1k, formatPricePerImage } from '../../lib/format'
import { qk } from '../../lib/queryKeys'
import type {
  AiConfigHealth,
  AiTaskBinding,
  AsrProtocol,
  LlmModelConfig,
  LlmPurpose,
} from '../../types'

interface LlmFormValues extends LlmConfigInput {
  apiKey?: string
}

function purposeLabel(purpose: LlmPurpose): string {
  if (purpose === 'embedding') return '向量检索'
  if (purpose === 'image') return '图片生成'
  return '内容生成'
}

export function ModelsPage() {
  const [tab, setTab] = useState('llm')
  return (
    <>
      <PageHeader
        title="模型配置"
        subtitle="维护内容生成与向量模型、语音识别渠道；密钥加密存储，仅管理员可见。"
      />
      <Card>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'llm', label: 'LLM 模型', children: <LlmPanel /> },
            { key: 'bindings', label: '任务绑定', children: <BindingsPanel /> },
            { key: 'health', label: '健康状态', children: <HealthPanel /> },
            { key: 'asr', label: '语音 ASR', children: <AsrPanel /> },
          ]}
        />
      </Card>
    </>
  )
}

function LlmPanel() {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [editing, setEditing] = useState<LlmModelConfig | null>(null)
  const [creating, setCreating] = useState(false)
  const configs = useQuery({ queryKey: qk.llmConfigs, queryFn: listLlmConfigs })

  const refresh = (): Promise<unknown> => queryClient.invalidateQueries({ queryKey: qk.llmConfigs })

  const test = useMutation({
    mutationFn: (configId: string) => testLlmConfig(configId),
    onSuccess: async result => {
      await refresh()
      if (result.status === 'success') void message.success('连接测试通过')
      else void message.error(`连接测试失败：${result.detail}`)
    },
  })

  const setDefault = useMutation({
    mutationFn: (configId: string) => setDefaultLlmConfig(configId),
    onSuccess: async () => {
      await refresh()
      void message.success('已设为默认配置')
    },
  })

  const toggle = useMutation({
    mutationFn: (config: LlmModelConfig) => patchLlmConfig(config.configId, { isActive: !config.isActive }),
    onSuccess: async () => {
      await refresh()
      void message.success('状态已更新')
    },
  })

  const remove = useMutation({
    mutationFn: (configId: string) => deleteLlmConfig(configId),
    onSuccess: async () => {
      await refresh()
      void message.success('配置已删除')
    },
  })

  const columns: ColumnsType<LlmModelConfig> = [
    {
      title: '配置',
      dataIndex: 'name',
      render: (name: string, config) => (
        <div className="segment-cell">
          <Space size={6} wrap>
            <Typography.Text strong>{name}</Typography.Text>
            {config.isDefault ? <Tag color="blue">默认</Tag> : null}
            {config.isActive ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>}
          </Space>
          <Typography.Text type="secondary">{config.provider}</Typography.Text>
        </div>
      ),
    },
    {
      title: '用途 / 协议',
      key: 'purpose',
      width: 160,
      render: (_value, config) => (
        <div className="segment-cell">
          <span>{purposeLabel(config.purpose)}</span>
          <Typography.Text type="secondary">{config.protocol}</Typography.Text>
        </div>
      ),
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 180,
      render: (model: string, config) => (
        <div className="segment-cell">
          <span>{model}</span>
          <Tooltip title={config.baseUrl}>
            <Typography.Text type="secondary" ellipsis>{config.baseUrl}</Typography.Text>
          </Tooltip>
        </div>
      ),
    },
    {
      title: '密钥',
      key: 'apiKey',
      width: 190,
      render: (_value, config) => (
        config.apiKeyConfigured
          ? <Typography.Text code style={{ whiteSpace: 'nowrap' }}>{config.apiKeyMasked ?? '已配置'}</Typography.Text>
          : <Tag>未配置</Tag>
      ),
    },
    {
      title: '价格',
      key: 'price',
      width: 190,
      render: (_value, config) => (
        config.purpose === 'image'
          ? <span>{formatPricePerImage(config.imagePriceMicros)}</span>
          : config.inputPriceMicrosPer1k === null && config.outputPriceMicrosPer1k === null
            ? <Typography.Text type="secondary">未配置</Typography.Text>
            : (
              <div className="segment-cell">
                <span>入 {formatPricePer1k(config.inputPriceMicrosPer1k)}</span>
                <span>出 {formatPricePer1k(config.outputPriceMicrosPer1k)}</span>
              </div>
            )
      ),
    },
    {
      title: '最近测试',
      key: 'test',
      width: 190,
      render: (_value, config) => (
        config.lastTestStatus === null ? (
          <Typography.Text type="secondary">未测试</Typography.Text>
        ) : (
          <div className="segment-cell">
            <StatusTag value={config.lastTestStatus} />
            <Typography.Text type="secondary">{formatDateTime(config.lastTestedAt)}</Typography.Text>
            {config.lastTestError === null ? null : (
              <Tooltip title={config.lastTestError}>
                <Typography.Text type="danger" ellipsis>{config.lastTestError}</Typography.Text>
              </Tooltip>
            )}
          </div>
        )
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_value, config) => (
        <Space wrap size={4}>
          <Button
            size="small"
            icon={<ExperimentOutlined />}
            loading={test.isPending && test.variables === config.configId}
            onClick={() => test.mutate(config.configId)}
          >
            测试
          </Button>
          <Button
            size="small"
            icon={<StarOutlined />}
            disabled={config.isDefault}
            onClick={() => setDefault.mutate(config.configId)}
          >
            设默认
          </Button>
          <Button size="small" onClick={() => toggle.mutate(config)}>
            {config.isActive ? '停用' : '启用'}
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(config)} />
          <Popconfirm
            title="删除该模型配置？"
            description="删除后使用该配置的生成/检索任务会失败。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove.mutate(config.configId)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <div className="table-toolbar">
        <Typography.Text type="secondary">
          默认配置用于未显式指定的任务；向量模型影响检索质量。
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          新增配置
        </Button>
      </div>
      <Table<LlmModelConfig>
        rowKey="configId"
        loading={configs.isLoading}
        columns={columns}
        dataSource={configs.data ?? []}
        pagination={false}
        scroll={{ x: 1220 }}
        locale={{ emptyText: '尚未配置模型' }}
      />
      <LlmConfigModal
        open={creating || editing !== null}
        config={editing}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
      />
    </>
  )
}

function LlmConfigModal({
  open,
  config,
  onClose,
}: {
  open: boolean
  config: LlmModelConfig | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [form] = Form.useForm<LlmFormValues>()

  useEffect(() => {
    if (!open) return
    if (config === null) {
      form.setFieldsValue({
        name: '',
        provider: 'openai',
        protocol: 'openai',
        baseUrl: '',
        model: '',
        purpose: 'content',
        apiKey: '',
        isDefault: false,
        isActive: true,
        inputPriceMicrosPer1k: null,
        outputPriceMicrosPer1k: null,
        imagePriceMicros: 120_000,
      })
      return
    }
    form.setFieldsValue({
      name: config.name,
      provider: config.provider,
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      model: config.model,
      purpose: config.purpose,
      apiKey: '',
      isDefault: config.isDefault,
      isActive: config.isActive,
      inputPriceMicrosPer1k: config.inputPriceMicrosPer1k,
      outputPriceMicrosPer1k: config.outputPriceMicrosPer1k,
      imagePriceMicros: config.imagePriceMicros,
    })
  }, [config, form, open])

  const save = useMutation({
    mutationFn: (values: LlmFormValues) => {
      const input: Partial<LlmConfigInput> = {
        name: values.name,
        provider: values.provider,
        protocol: values.protocol,
        baseUrl: values.baseUrl,
        model: values.model,
        purpose: values.purpose,
        ...(values.apiKey === undefined || values.apiKey.trim() === '' ? {} : { apiKey: values.apiKey.trim() }),
        isDefault: values.isDefault,
        isActive: values.isActive,
        inputPriceMicrosPer1k: values.inputPriceMicrosPer1k ?? null,
        outputPriceMicrosPer1k: values.outputPriceMicrosPer1k ?? null,
        imagePriceMicros: values.imagePriceMicros ?? 120_000,
      }
      return config === null
        ? createLlmConfig(input as LlmConfigInput)
        : patchLlmConfig(config.configId, input)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.llmConfigs })
      void message.success(config === null ? '配置已创建' : '配置已更新')
      onClose()
    },
  })

  return (
    <Modal
      open={open}
      title={config === null ? '新增模型配置' : '编辑模型配置'}
      okText="保存"
      cancelText="取消"
      width={640}
      confirmLoading={save.isPending}
      onCancel={onClose}
      onOk={() => {
        void form.validateFields().then(values => save.mutate(values))
      }}
      destroyOnHidden
    >
      <Form<LlmFormValues> form={form} layout="vertical" preserve={false}>
        <Space size={12} wrap>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input style={{ width: 240 }} placeholder="例如 deepseek-chat" />
          </Form.Item>
          <Form.Item name="purpose" label="用途" rules={[{ required: true }]}>
            <Select
              style={{ width: 150 }}
              options={[
                { value: 'content', label: '内容生成' },
                { value: 'embedding', label: '向量检索' },
                { value: 'image', label: '图片生成' },
              ]}
            />
          </Form.Item>
        </Space>
        <Space size={12} wrap>
          <Form.Item name="provider" label="提供方" rules={[{ required: true, message: '请输入提供方' }]}>
            <Input style={{ width: 180 }} placeholder="openai / deepseek / minimax" />
          </Form.Item>
          <Form.Item name="protocol" label="协议">
            <Select
              style={{ width: 160 }}
              options={[
                { value: 'openai', label: 'OpenAI 兼容' },
                { value: 'anthropic', label: 'Anthropic' },
              ]}
            />
          </Form.Item>
          <Form.Item name="model" label="模型名" rules={[{ required: true, message: '请输入模型名' }]}>
            <Input style={{ width: 200 }} />
          </Form.Item>
        </Space>
        <Form.Item
          name="baseUrl"
          label="Base URL"
          rules={[
            { required: true, message: '请输入 Base URL' },
            { type: 'url', message: '请输入合法的 URL' },
          ]}
        >
          <Input placeholder="https://api.example.com/v1" />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label="API Key"
          extra={config === null ? '密钥会加密存储。' : '留空表示保留现有密钥。'}
        >
          <Input.Password autoComplete="new-password" placeholder={config === null ? 'sk-...' : '留空保持不变'} />
        </Form.Item>
        <Space size={12} wrap>
          <Form.Item
            name="inputPriceMicrosPer1k"
            label="输入价格（微美元/千 token）"
            extra="留空表示未配置，成本估算显示为未配置。"
          >
            <InputNumber min={0} precision={0} style={{ width: 220 }} placeholder="例如 1000" />
          </Form.Item>
          <Form.Item
            name="outputPriceMicrosPer1k"
            label="输出价格（微美元/千 token）"
          >
            <InputNumber min={0} precision={0} style={{ width: 220 }} placeholder="例如 2000" />
          </Form.Item>
        </Space>
        <Form.Item
          name="imagePriceMicros"
          label="图片单价（微美元/张）"
          extra="仅图片生成用途生效；默认 120000，约 ¥0.12。图片预算按成功张数累计。"
        >
          <InputNumber min={0} precision={0} style={{ width: 220 }} placeholder="例如 120000" />
        </Form.Item>
        <Space size={24}>
          <Form.Item name="isDefault" valuePropName="checked">
            <Checkbox>设为默认配置</Checkbox>
          </Form.Item>
          <Form.Item name="isActive" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  )
}

function BindingsPanel() {
  const bindings = useQuery({ queryKey: qk.aiBindings, queryFn: getAiBindings })

  return (
    <div className="bindings-panel">
      <div className="table-toolbar">
        <Typography.Text type="secondary">
          按任务绑定主/备模型；未绑定的任务使用对应用途的默认启用模型，保存后立即生效。
        </Typography.Text>
      </div>
      {bindings.isLoading ? (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      ) : (
        <div className="binding-list">
          {(bindings.data?.bindings ?? []).map(binding => (
            <BindingEditor
              key={binding.taskKey}
              binding={binding}
              configs={bindings.data?.configs ?? []}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function BindingEditor({
  binding,
  configs,
}: {
  binding: AiTaskBinding
  configs: LlmModelConfig[]
}) {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [primary, setPrimary] = useState(binding.primaryConfigId ?? '')
  const [fallback, setFallback] = useState(binding.fallbackConfigId ?? '')

  useEffect(() => {
    setPrimary(binding.primaryConfigId ?? '')
    setFallback(binding.fallbackConfigId ?? '')
  }, [binding.primaryConfigId, binding.fallbackConfigId, binding.updatedAt])

  const purposeLabelText = purposeLabel(binding.purpose)
  const options = configs
    .filter(config => config.purpose === binding.purpose && config.isActive)
    .map(config => ({ value: config.configId, label: `${config.name} · ${config.model}` }))
  const invalid = primary !== '' && fallback === primary
  const dirty = (binding.primaryConfigId ?? '') !== primary
    || (binding.fallbackConfigId ?? '') !== fallback

  const save = useMutation({
    mutationFn: () => putAiBinding(binding.taskKey, {
      primaryConfigId: primary === '' ? null : primary,
      fallbackConfigId: fallback === '' ? null : fallback,
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.aiBindings }),
        queryClient.invalidateQueries({ queryKey: qk.aiHealth }),
      ])
      void message.success('任务绑定已保存')
    },
    onError: error => void message.error(errorText(error)),
  })

  return (
    <div className="binding-row">
      <div className="binding-task">
        <Space size={6} wrap>
          <Typography.Text strong>{binding.label}</Typography.Text>
          <Tag>{purposeLabelText}</Tag>
        </Space>
        <Typography.Text type="secondary" code>{binding.taskKey}</Typography.Text>
      </div>
      <Select
        placeholder="主模型（未绑定，使用默认）"
        allowClear
        value={primary === '' ? undefined : primary}
        options={options}
        onChange={value => {
          const next = value ?? ''
          setPrimary(next)
          if (next === '') setFallback('')
        }}
      />
      <Select
        placeholder="备用模型（可选）"
        allowClear
        disabled={primary === ''}
        value={fallback === '' ? undefined : fallback}
        options={options.filter(option => option.value !== primary)}
        onChange={value => setFallback(value ?? '')}
      />
      <div className="binding-actions">
        {invalid ? <Typography.Text type="danger">备用模型不能与主模型相同</Typography.Text> : null}
        <Button
          type="primary"
          disabled={!dirty || invalid}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          保存
        </Button>
      </div>
    </div>
  )
}

function HealthPanel() {
  const queryClient = useQueryClient()
  const health = useQuery({
    queryKey: qk.aiHealth,
    queryFn: getAiHealth,
    refetchInterval: 15_000,
  })

  const columns: ColumnsType<AiConfigHealth> = [
    {
      title: '配置',
      key: 'config',
      render: (_value, row) => (
        <div className="segment-cell">
          <Typography.Text strong>{row.name}</Typography.Text>
          <Typography.Text type="secondary">{row.provider} · {row.model}</Typography.Text>
        </div>
      ),
    },
    {
      title: '用途',
      dataIndex: 'purpose',
      width: 110,
      render: (purpose: LlmPurpose) => (purpose === 'embedding' ? '向量检索' : '内容生成'),
    },
    {
      title: '状态',
      key: 'status',
      width: 150,
      render: (_value, row) => (
        <Space size={4} wrap>
          <StatusTag value={row.isActive ? 'active' : 'disabled'} />
          <Tag color={row.coolingDown ? 'red' : 'green'}>
            {row.coolingDown ? '冷却中' : '可用'}
          </Tag>
        </Space>
      ),
    },
    {
      title: '连续失败',
      dataIndex: 'consecutiveFailures',
      width: 100,
    },
    {
      title: '冷却至',
      dataIndex: 'cooldownUntil',
      width: 170,
      render: (value: string | null) => formatIso(value),
    },
    {
      title: '最近错误',
      dataIndex: 'lastError',
      width: 160,
      render: (value: string | null) => value === null
        ? '—'
        : <Tooltip title={value}><Typography.Text type="danger" ellipsis>{value}</Typography.Text></Tooltip>,
    },
    {
      title: '最近成功',
      dataIndex: 'lastSuccessAt',
      width: 170,
      render: (value: string | null) => formatIso(value),
    },
  ]

  return (
    <div className="health-panel">
      <div className="table-toolbar">
        <Typography.Text type="secondary">
          主模型遇到 429、5xx、超时或网络错误时冷却 60 秒并自动切到备用模型。
        </Typography.Text>
        <Button
          icon={<ExperimentOutlined />}
          onClick={() => void queryClient.invalidateQueries({ queryKey: qk.aiHealth })}
        >
          刷新
        </Button>
      </div>
      <Table<AiConfigHealth>
        rowKey="configId"
        size="middle"
        loading={health.isLoading}
        columns={columns}
        dataSource={health.data?.configs ?? []}
        pagination={false}
        scroll={{ x: 1020 }}
        locale={{ emptyText: '尚未配置模型' }}
      />
    </div>
  )
}

function AsrPanel() {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [form] = Form.useForm<{
    provider: string
    protocol: AsrProtocol
    baseUrl: string
    model: string
    apiKey: string
    enabled: boolean
  }>()
  const config = useQuery({ queryKey: qk.asrConfig, queryFn: getAsrConfig })

  useEffect(() => {
    if (config.data === undefined) return
    form.setFieldsValue({
      provider: config.data.provider,
      protocol: config.data.protocol,
      baseUrl: config.data.baseUrl,
      model: config.data.model,
      apiKey: '',
      enabled: config.data.enabled,
    })
  }, [config.data, form])

  const save = useMutation({
    mutationFn: (values: {
      provider: string
      protocol: AsrProtocol
      baseUrl: string
      model: string
      apiKey: string
      enabled: boolean
    }) => patchAsrConfig({
      provider: values.provider,
      protocol: values.protocol,
      baseUrl: values.baseUrl,
      model: values.model,
      ...(values.apiKey.trim() === '' ? {} : { apiKey: values.apiKey.trim() }),
      enabled: values.enabled,
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.asrConfig })
      void message.success('ASR 配置已保存')
    },
  })

  const test = useMutation({
    mutationFn: testAsrConfig,
    onSuccess: async result => {
      await queryClient.invalidateQueries({ queryKey: qk.asrConfig })
      if (result.status === 'success') void message.success('ASR 连接测试通过')
      else void message.error(`ASR 连接测试失败：${result.detail}`)
    },
  })

  const data = config.data

  return (
    <div className="asr-panel">
      <div className="table-toolbar">
        <Typography.Text type="secondary">
          语音识别服务用于视频转写；修改后立即生效。
        </Typography.Text>
        <Space>
          <Button
            icon={<ExperimentOutlined />}
            loading={test.isPending}
            disabled={data === undefined}
            onClick={() => test.mutate()}
          >
            测试连接
          </Button>
          <Button type="primary" loading={save.isPending} onClick={() => {
            void form.validateFields().then(values => save.mutate(values))
          }}>
            保存
          </Button>
        </Space>
      </div>

      {data === undefined ? null : (
        <Space size={16} wrap className="asr-meta">
          <StatusTag value={data.enabled ? 'success' : 'disabled'} label={data.enabled ? '已启用' : '已停用'} />
          {data.apiKeyConfigured ? <Tag color="blue">密钥已配置</Tag> : <Tag>密钥未配置</Tag>}
          {data.lastTestStatus === null ? (
            <Typography.Text type="secondary">未测试</Typography.Text>
          ) : (
            <Space size={6}>
              <StatusTag value={data.lastTestStatus} />
              <Typography.Text type="secondary">{formatDateTime(data.lastTestedAt)}</Typography.Text>
              {data.lastTestError === null ? null : (
                <Tooltip title={data.lastTestError}>
                  <Typography.Text type="danger">{data.lastTestError}</Typography.Text>
                </Tooltip>
              )}
            </Space>
          )}
        </Space>
      )}

      <Form form={form} layout="vertical" className="asr-form">
        <Space size={12} wrap>
          <Form.Item name="provider" label="提供方" rules={[{ required: true, message: '请输入提供方' }]}>
            <Input style={{ width: 200 }} placeholder="minimax / openai" />
          </Form.Item>
          <Form.Item name="protocol" label="协议">
            <Select
              style={{ width: 170 }}
              options={[
                { value: 'minimax', label: 'MiniMax' },
                { value: 'openai', label: 'OpenAI 兼容' },
              ]}
            />
          </Form.Item>
          <Form.Item name="model" label="模型" rules={[{ required: true, message: '请输入模型名' }]}>
            <Input style={{ width: 200 }} />
          </Form.Item>
        </Space>
        <Form.Item
          name="baseUrl"
          label="Base URL"
          rules={[
            { required: true, message: '请输入 Base URL' },
            { type: 'url', message: '请输入合法的 URL' },
          ]}
        >
          <Input placeholder="https://api.minimax.chat/v1" />
        </Form.Item>
        <Form.Item name="apiKey" label="API Key" extra="留空表示保留现有密钥。">
          <Input.Password autoComplete="new-password" placeholder="留空保持不变" />
        </Form.Item>
        <Form.Item name="enabled" label="启用 ASR" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </div>
  )
}
