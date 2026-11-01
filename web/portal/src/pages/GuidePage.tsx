import { AppleOutlined, WindowsOutlined } from '@ant-design/icons'
import { Alert, Button, Segmented } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CodeBlock } from '../components/CodeBlock'
import { PageHero } from '../components/PageHero'
import { PageMarkdown } from '../components/PageMarkdown'
import { content } from '../content'
import { DSH_VERSION, PLUGIN_FILE, WEB_APP_PACKAGE } from '../release'
import { usePageMeta } from '../usePageMeta'

type GuideStep = {
  title: string
  text: string
  code?: string
  codeLabel?: string
  expect?: string
  tip?: string
  link?: { href: string; text: string }
}

const NODE_DOWNLOAD = 'https://nodejs.org/zh-cn/download'

const WINDOWS_PLUGIN_PATH = `%USERPROFILE%\\Downloads\\${PLUGIN_FILE}`
const MAC_PLUGIN_PATH = `$HOME/Downloads/${PLUGIN_FILE}`

const WINDOWS_STEPS: GuideStep[] = [
  {
    title: '确认电脑版本',
    text: '点击屏幕左下角「开始」→「设置」→「系统」→「关于」，查看「Windows 规格」。本向导支持 Windows 10 和 Windows 11（64 位）。如果显示的是 Windows 7 或 Windows 8，请先联系管理员，新版 Node.js 无法安装在这两个系统上。',
    tip: '不确定也不用停，接着做下一步；如果第 3 步的黑色窗口提示「不是内部或外部命令」，通常就是系统版本太旧。',
  },
  {
    title: '安装 Node.js（只需装一次）',
    text: '打开 Node.js 官网下载页，点击「Windows 安装包 (.msi)」下载。下载完成后双击这个安装包，之后每一页都点「Next / 下一步」，不要修改任何选项，最后点「Install / 安装」，完成后再点「Finish / 完成」。',
    link: { href: NODE_DOWNLOAD, text: '打开 Node.js 下载页' },
    tip: '如果弹出「是否允许此应用对你的设备进行更改」，点「是」。装完关掉所有安装窗口即可。',
  },
  {
    title: '打开黑色命令窗口，检查 Node.js',
    text: '同时按键盘上的 Windows 键和 R 键，在弹出的小窗口里输入 cmd，按回车，就会出现一个黑色窗口。复制下面这条命令，在黑窗口里点一下鼠标右键（右键就是粘贴），再按回车。',
    code: 'node -v',
    expect: '看到以 v22 开头的版本号（例如 v22.20.0）就说明安装成功。如果提示「不是内部或外部命令」，请重启电脑后再试一次。',
    tip: '这个黑色窗口后面还要继续用，先不要关。',
  },
  {
    title: '下载学习插件',
    text: `打开本站「下载」页，点击「下载安装包」。浏览器会自动把文件保存到「下载」文件夹，文件名以 .tgz 结尾。不要解压、不要改文件名。`,
    tip: '如果浏览器提示「不常下载的文件」，请点「保留」。如果下载后变成了文件夹（被自动解压），请改用 Chrome 或 Edge 浏览器重新下载。',
  },
  {
    title: '安装学习插件',
    text: `回到刚才的黑色窗口，复制下面整行命令，右键粘贴后按回车。第一次运行需要下载组件，可能要等 1～3 分钟。中途出现「Ok to proceed? (y)」时，输入字母 y 再按回车。`,
    code: `npx --yes @deepseek-ai/dsh@${DSH_VERSION} plugin --profile trend-coach add -w "${WINDOWS_PLUGIN_PATH}"`,
    expect: '最后出现 added 或安装成功的字样，并且没有红色的报错，就表示装好了。',
    tip: '命令比较长，请一定点代码框右上角的「复制」，不要手动输入。命令里的内容一个字都不要改。',
  },
  {
    title: '安装网页界面（推荐）',
    text: '继续在同一个黑色窗口里粘贴下面这条命令并回车。它用来显示课程体系和问答面板。',
    code: `npx --yes @deepseek-ai/dsh@${DSH_VERSION} plugin --profile trend-coach add ${WEB_APP_PACKAGE}`,
    tip: '这一步如果报错，可以先跳过，直接做下一步，不影响课程内容与问答。',
  },
  {
    title: '启动客户端',
    text: '复制最后这条启动命令并回车。启动成功后浏览器会自动打开；如果没有自动打开，请手动打开地址 http://localhost:3939 。',
    code: `npx --yes @deepseek-ai/dsh@${DSH_VERSION} --profile trend-coach --port 3939`,
    expect: '浏览器里出现 dsh 界面，左侧边栏能看到「趋势伴学」，就表示启动成功。',
    tip: '黑色窗口不要关闭，最小化即可。关掉黑窗口就等于退出客户端，下次使用需要重新启动。',
  },
  {
    title: '登录并授权',
    text: '在左侧边栏点击「趋势伴学」，再点「设备登录」。浏览器会打开授权页面，用本站注册的账号登录，确认页面显示的数字后点击「批准」。回到客户端等待几秒，面板会自动变成已登录。',
    tip: '授权码有时间限制。如果提示过期，回到客户端重新点一次「设备登录」即可。',
  },
]

const MAC_STEPS: GuideStep[] = [
  {
    title: '确认电脑版本',
    text: '点击屏幕左上角的苹果菜单，选择「关于本机」，确认 macOS 版本为 12 或更高。如果版本太旧，请先升级系统，或联系管理员。',
  },
  {
    title: '安装 Node.js（只需装一次）',
    text: '打开 Node.js 官网下载页，点击「macOS 安装包 (.pkg)」下载。下载完成后双击安装包，一路点「继续 / 同意 / 安装」，需要时输入开机密码。Apple 芯片和 Intel 芯片使用同一个安装包。',
    link: { href: NODE_DOWNLOAD, text: '打开 Node.js 下载页' },
  },
  {
    title: '打开终端，检查 Node.js',
    text: '按住键盘上的 Command 键再按空格键，输入「终端」或 Terminal，按回车打开终端窗口。复制下面这条命令，粘贴到终端里（Command + V），按回车。',
    code: 'node -v',
    expect: '看到以 v22 开头的版本号（例如 v22.20.0）就说明安装成功。如果提示 command not found，请重新打开终端再试一次。',
    tip: '终端窗口后面还要继续用，先不要关。',
  },
  {
    title: '下载学习插件',
    text: '打开本站「下载」页，点击「下载安装包」，文件会保存到「下载」文件夹，文件名以 .tgz 结尾。不要解压、不要改文件名。',
    tip: 'Safari 可能会自动解压。如果下载后变成了文件夹，请改用 Chrome 或 Edge 重新下载，或联系管理员。',
  },
  {
    title: '安装学习插件',
    text: '回到终端窗口，复制下面整行命令并回车。第一次运行需要下载组件，可能要等 1～3 分钟。出现「Ok to proceed? (y)」时，输入字母 y 再按回车。',
    code: `npx --yes @deepseek-ai/dsh@${DSH_VERSION} plugin --profile trend-coach add -w "${MAC_PLUGIN_PATH}"`,
    expect: '最后出现 added 或安装成功的字样，并且没有红色报错，就表示装好了。',
    tip: '命令请用代码框右上角的「复制」，不要手动输入。',
  },
  {
    title: '安装网页界面（推荐）',
    text: '继续在同一个终端窗口粘贴下面这条命令并回车。它用来显示课程体系和问答面板。',
    code: `npx --yes @deepseek-ai/dsh@${DSH_VERSION} plugin --profile trend-coach add ${WEB_APP_PACKAGE}`,
    tip: '这一步如果报错，可以先跳过，不影响课程内容与问答。',
  },
  {
    title: '启动客户端',
    text: '复制最后这条启动命令并回车。启动成功后浏览器会自动打开；如果没有自动打开，请手动打开地址 http://localhost:3939 。',
    code: `npx --yes @deepseek-ai/dsh@${DSH_VERSION} --profile trend-coach --port 3939`,
    expect: '浏览器里出现 dsh 界面，左侧边栏能看到「趋势伴学」，就表示启动成功。',
    tip: '终端窗口不要关闭，最小化即可。关闭终端就等于退出客户端。',
  },
  {
    title: '登录并授权',
    text: '在左侧边栏点击「趋势伴学」，再点「设备登录」。浏览器会打开授权页面，用本站注册的账号登录，确认页面显示的数字后点击「批准」。回到客户端等待几秒，面板会自动变成已登录。',
    tip: '授权码有时间限制。如果提示过期，回到客户端重新点一次「设备登录」即可。',
  },
]

const HELPERS = [
  '一次只做一步，做完这一步再进入下一步。',
  '命令请点代码框右上角的「复制」，不要手动输入。',
  '看到「Ok to proceed? (y)」时，输入字母 y 再按回车。',
  '黑色窗口或终端窗口不要关，最小化即可。',
  '安装位置保持默认，不要修改任何路径。',
]

export function GuidePage() {
  usePageMeta('/guide')
  const [os, setOs] = useState<'windows' | 'mac'>('windows')
  const steps = os === 'windows' ? WINDOWS_STEPS : MAC_STEPS

  return (
    <>
      <PageHero
        kicker="使用向导"
        title="照着做，十分钟装好"
        description="Windows 和 macOS 分开写，每一步都告诉你点哪里、粘贴什么、会看到什么。第一次安装请从第 1 步开始，不要跳步。"
      >
        <Link to="/downloads"><Button type="primary">先下载插件</Button></Link>
        <Link to="/faq"><Button>常见问题</Button></Link>
      </PageHero>

      <section className="content-section">
        <div className="guide-os-switch">
          <Segmented
            size="large"
            value={os}
            onChange={value => setOs(value as 'windows' | 'mac')}
            options={[
              { label: 'Windows 电脑', value: 'windows', icon: <WindowsOutlined /> },
              { label: '苹果电脑 macOS', value: 'mac', icon: <AppleOutlined /> },
            ]}
          />
        </div>

        <Alert
          type="warning"
          showIcon
          className="guide-alert"
          message="开始前请先记住"
          description={(
            <ul className="guide-helper-list">
              {HELPERS.map(item => <li key={item}>{item}</li>)}
            </ul>
          )}
        />

        {os === 'windows' && (
          <Alert
            type="error"
            showIcon
            className="guide-alert"
            message="Windows 7 / Windows 8 无法安装"
            description="新版 Node.js 只支持 Windows 10 和 Windows 11（64 位）。如果电脑是老系统，请先联系管理员，不要自行尝试。"
          />
        )}

        <ol className="guide-steps">
          {steps.map((step, index) => (
            <li key={step.title} className="guide-step">
              <div className="guide-step-head">
                <span className="guide-step-index">{String(index + 1).padStart(2, '0')}</span>
                <h2>{step.title}</h2>
              </div>
              <p>{step.text}</p>
              {step.link !== undefined && (
                <p className="guide-step-link">
                  <a href={step.link.href} target="_blank" rel="noreferrer">{step.link.text}</a>
                </p>
              )}
              {step.code !== undefined && (
                <CodeBlock code={step.code} label={os === 'windows' ? '命令提示符' : '终端'} />
              )}
              {step.expect !== undefined && (
                <p className="guide-step-expect"><strong>你会看到：</strong>{step.expect}</p>
              )}
              {step.tip !== undefined && (
                <p className="guide-step-tip"><strong>小提示：</strong>{step.tip}</p>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="content-section content-section-narrow">
        <h2 className="content-section-title">安装排错</h2>
        <PageMarkdown value={content('guide')} />
      </section>
    </>
  )
}
