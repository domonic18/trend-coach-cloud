import {
  CloudUploadOutlined,
  FileSearchOutlined,
  InboxOutlined,
  PlayCircleOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  App,
  Button,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import {
  enqueueGeneration,
  enqueueIngest,
  patchMediaAsset,
  uploadMediaSource,
} from '../../api'
import { StatusTag } from '../../components/StatusTag'
import { errorText, formatBytes, formatClock } from '../../lib/format'
import type { MediaAsset } from '../../types'

export function AssetTable({
  assets,
  loading,
  language,
  onTranscript,
}: {
  assets: MediaAsset[]
  loading: boolean
  language: 'zh' | 'en' | 'auto'
  onTranscript: (asset: MediaAsset) => void
}) {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [uploadingId, setUploadingId] = useState<string | null>(null)

  const refresh = (): Promise<unknown> => queryClient.invalidateQueries({ queryKey: ['pipeline'] })

  const ingest = useMutation({
    mutationFn: (assetId: string) => enqueueIngest(assetId, language),
    onSuccess: async () => {
      await refresh()
      void message.success('已入队转码与转写')
    },
  })

  const generate = useMutation({
    mutationFn: (assetId: string) => enqueueGeneration(assetId),
    onSuccess: async () => {
      await refresh()
      void message.success('已入队内容生成')
    },
  })

  const archive = useMutation({
    mutationFn: (assetId: string) => patchMediaAsset(assetId, { status: 'archived' }),
    onSuccess: async () => {
      await refresh()
      void message.success('素材已归档')
    },
  })

  const upload = async (asset: MediaAsset, file: File): Promise<void> => {
    setUploadingId(asset.assetId)
    setProgress(current => ({ ...current, [asset.assetId]: 0 }))
    try {
      const updated = await uploadMediaSource(asset.assetId, file, ratio => {
        setProgress(current => ({ ...current, [asset.assetId]: ratio }))
      })
      void message.success(`已上传 ${formatBytes(updated.sourceSizeBytes)}`)
      await refresh()
    } catch (cause) {
      void message.error(errorText(cause))
    } finally {
      setUploadingId(null)
      setProgress(current => {
        const next = { ...current }
        delete next[asset.assetId]
        return next
      })
    }
  }

  const columns: ColumnsType<MediaAsset> = [
    {
      title: '素材',
      dataIndex: 'title',
      render: (title: string | null, asset) => (
        <div className="segment-cell">
          <Typography.Text strong>{title ?? asset.assetId}</Typography.Text>
          <Typography.Text type="secondary">{asset.assetId}</Typography.Text>
          {asset.errorCode === null ? null : (
            <Typography.Text type="danger">错误：{asset.errorCode}</Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 160,
      render: (status: string, asset) => (
        <Space direction="vertical" size={4} className="asset-status">
          <StatusTag value={status} />
          {progress[asset.assetId] === undefined ? null : (
            <Progress percent={Math.round((progress[asset.assetId] ?? 0) * 100)} size="small" />
          )}
        </Space>
      ),
    },
    {
      title: '时长 / 大小',
      key: 'size',
      width: 140,
      render: (_value, asset) => (
        <div className="segment-cell">
          <span>{formatClock(asset.durationMs)}</span>
          <Typography.Text type="secondary">{formatBytes(asset.sourceSizeBytes)}</Typography.Text>
        </div>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 330,
      render: (_value, asset) => {
        const canUpload = asset.status === 'awaiting_upload'
          || asset.status === 'uploaded'
          || asset.status === 'failed'
        const canIngest = asset.status === 'uploaded' || asset.status === 'failed' || asset.status === 'ready'
        const canArchive = asset.status === 'ready' || asset.status === 'uploaded'
        return (
          <Space wrap size={4}>
            <Upload
              accept="video/*"
              showUploadList={false}
              disabled={!canUpload || uploadingId !== null}
              beforeUpload={file => {
                void upload(asset, file)
                return Upload.LIST_IGNORE
              }}
            >
              <Tooltip title={canUpload ? '上传或替换源视频' : '当前状态不可上传'}>
                <Button
                  size="small"
                  icon={<CloudUploadOutlined />}
                  loading={uploadingId === asset.assetId}
                  disabled={!canUpload || (uploadingId !== null && uploadingId !== asset.assetId)}
                >
                  上传
                </Button>
              </Tooltip>
            </Upload>
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              disabled={!canIngest}
              loading={ingest.isPending && ingest.variables === asset.assetId}
              onClick={() => ingest.mutate(asset.assetId)}
            >
              处理
            </Button>
            <Button
              size="small"
              icon={<FileSearchOutlined />}
              disabled={asset.status !== 'ready'}
              onClick={() => onTranscript(asset)}
            >
              转写
            </Button>
            <Button
              size="small"
              icon={<RobotOutlined />}
              disabled={asset.status !== 'ready'}
              loading={generate.isPending && generate.variables === asset.assetId}
              onClick={() => generate.mutate(asset.assetId)}
            >
              生成
            </Button>
            <Popconfirm
              title="归档该素材？"
              description="归档后不再参与建课操作。"
              okText="归档"
              cancelText="取消"
              disabled={!canArchive}
              onConfirm={() => archive.mutate(asset.assetId)}
            >
              <Button size="small" icon={<InboxOutlined />} disabled={!canArchive}>归档</Button>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <Table<MediaAsset>
      rowKey="assetId"
      loading={loading}
      columns={columns}
      dataSource={assets}
      pagination={false}
      scroll={{ x: 900 }}
      locale={{ emptyText: '该课程暂无素材' }}
    />
  )
}
