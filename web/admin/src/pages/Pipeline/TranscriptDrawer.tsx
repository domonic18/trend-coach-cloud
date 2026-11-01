import { useQuery } from '@tanstack/react-query'
import { Drawer, List, Pagination, Space, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { getTranscript } from '../../api'
import { formatClock } from '../../lib/format'
import { qk } from '../../lib/queryKeys'
import type { MediaAsset } from '../../types'

export function TranscriptDrawer({
  asset,
  open,
  onClose,
}: {
  asset: MediaAsset | null
  open: boolean
  onClose: () => void
}) {
  const [offset, setOffset] = useState(0)
  const limit = 100

  useEffect(() => {
    setOffset(0)
  }, [asset?.assetId])

  const transcript = useQuery({
    queryKey: qk.transcript(asset?.assetId ?? '', offset, limit),
    queryFn: () => getTranscript(asset?.assetId ?? '', { offset, limit }),
    enabled: open && asset !== null,
  })

  const meta = transcript.data?.transcript

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(860px, 94vw)"
      title={asset?.title === null || asset?.title === undefined ? '转写结果' : `转写 · ${asset.title}`}
      destroyOnHidden
    >
      <Space direction="vertical" size={16} className="pipeline-drawer-body">
        <Space wrap>
          <Tag bordered={false}>{asset?.assetId}</Tag>
          {meta === undefined ? null : (
            <>
              <Tag color={meta.status === 'succeeded' ? 'green' : 'default'}>{meta.status}</Tag>
              <Typography.Text type="secondary">语言 {meta.language}</Typography.Text>
              <Typography.Text type="secondary">时长 {formatClock(meta.durationMs)}</Typography.Text>
              <Typography.Text type="secondary">分块 {meta.chunkCount}</Typography.Text>
              <Typography.Text type="secondary">共 {transcript.data?.total ?? 0} 段</Typography.Text>
            </>
          )}
        </Space>

        <List
          loading={transcript.isLoading}
          dataSource={transcript.data?.segments ?? []}
          pagination={false}
          renderItem={segment => (
            <List.Item>
              <div className="transcript-row">
                <Typography.Text type="secondary" className="transcript-time">
                  {formatClock(segment.startMs)} – {formatClock(segment.endMs)}
                </Typography.Text>
                <Typography.Text>{segment.text}</Typography.Text>
              </div>
            </List.Item>
          )}
        />

        <Pagination
          size="small"
          current={Math.floor(offset / limit) + 1}
          pageSize={limit}
          total={transcript.data?.total ?? 0}
          showSizeChanger={false}
          hideOnSinglePage
          onChange={page => setOffset((page - 1) * limit)}
          showTotal={total => `共 ${total} 段`}
        />
      </Space>
    </Drawer>
  )
}
