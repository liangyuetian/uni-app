import path from 'path'
import fs from 'fs-extra'

import type {
  UTSBundleOptions,
  UTSInputOptions,
  UTSResult,
} from '@dcloudio/uts'

import {
  D8_DEFAULT_ARGS,
  KotlinCompilerServer,
  RunKotlinDevResult,
  getUniModulesCacheJars,
  getUniModulesJars,
  resolveKotlincArgs,
  createStderrListener,
} from '../kotlin'
import { parseUTSSyntaxError } from '../stacktrace'
import {
  getCompilerServer,
  getUTSCompiler,
  resolveUniAppXSourceMapPath,
} from '../utils'

const DEFAULT_IMPORTS = [
  'kotlinx.coroutines.async',
  'kotlinx.coroutines.CoroutineScope',
  'kotlinx.coroutines.Deferred',
  'kotlinx.coroutines.Dispatchers',
  'io.dcloud.uts.Map',
  'io.dcloud.uts.Set',
  'io.dcloud.uts.UTSAndroid',
  'io.dcloud.uts.*',
  'io.dcloud.uniapp.framework.*',
  'io.dcloud.uniapp.vue.*',
  'io.dcloud.uniapp.vue.shared.*',
  'io.dcloud.uniapp.runtime.*',
  'io.dcloud.uniapp.extapi.*',
]

export interface CompileAppOptions {
  inputDir: string
  outputDir: string
  package: string
  sourceMap: boolean
  uni_modules: string[]
  extApis?: Record<string, [string, string]>
  split?: boolean
  disableSplitManifest?: boolean
}
export async function compileApp(entry: string, options: CompileAppOptions) {
  const split = !!options.split
  const { bundle, UTSTarget } = getUTSCompiler()
  const imports = [...DEFAULT_IMPORTS]
  const isProd = process.env.NODE_ENV !== 'development'
  const {
    package: pkg,
    inputDir,
    outputDir,
    sourceMap,
    uni_modules,
    extApis,
  } = options

  const input: UTSInputOptions = {
    root: inputDir,
    filename: entry,
    paths: {
      vue: 'io.dcloud.uniapp.vue',
    },
    uniModules: uni_modules,
    globals: {
      envs: {
        // 自动化测试
        NODE_ENV: process.env.NODE_ENV,
        UNI_AUTOMATOR_WS_ENDPOINT: process.env.UNI_AUTOMATOR_WS_ENDPOINT || '',
      },
    },
  }

  const bundleOptions: UTSBundleOptions = {
    input,
    output: {
      isX: true,
      isApp: true,
      isPlugin: false,
      outDir: isProd
        ? kotlinSrcDir(path.resolve(outputDir, '.uniappx/android/'))
        : kotlinSrcDir(kotlinDir(outputDir)),
      package: pkg,
      sourceMap:
        sourceMap !== false
          ? resolveUniAppXSourceMapPath(kotlinDir(outputDir))
          : false,
      extname: 'kt',
      imports,
      logFilename: true,
      noColor: true,
      split,
      disableSplitManifest: options.disableSplitManifest,
      transform: {
        uniExtApiDefaultNamespace: 'io.dcloud.uniapp.extapi',
        uniExtApiNamespaces: extApis,
        uvueClassNamePrefix: 'Gen',
      },
    },
  }
  // const time = Date.now()
  // console.log(bundleOptions)
  const result = await bundle(UTSTarget.KOTLIN, bundleOptions)
  // console.log('UTS编译耗时: ' + (Date.now() - time) + 'ms')
  if (!result) {
    return
  }

  if (result.error) {
    throw parseUTSSyntaxError(result.error, inputDir)
  }

  if (isProd) {
    return runKotlinBuild(options, result)
  }

  return runKotlinDev(options, result as RunKotlinDevResult)
}

function kotlinDir(outputDir: string) {
  return (
    process.env.UNI_APP_X_CACHE_DIR || path.resolve(outputDir, '../.kotlin')
  )
}

function kotlinSrcDir(kotlinDir: string) {
  return path.resolve(kotlinDir, 'src')
}

function kotlinDexDir(kotlinDir: string) {
  return path.resolve(kotlinDir, 'dex')
}

function kotlinClassDir(kotlinDir: string) {
  return path.resolve(kotlinDir, 'class')
}

function resolveDexByKotlinFile(kotlinDexOutDir: string, kotlinFile: string) {
  return path.join(
    path.resolve(kotlinDexOutDir, kotlinFile).replace('.kt', ''),
    'classes.dex'
  )
}

function parseKotlinChangedFiles(
  result: RunKotlinDevResult,
  kotlinSrcOutDir: string,
  kotlinDexOutDir: string,
  outputDir: string
) {
  // 解析发生变化的
  const kotlinChangedFiles = result.changed.map((file) => {
    const dexFile = resolveDexByKotlinFile(kotlinDexOutDir, file)
    // 如果kt文件变化，则删除对应的dex文件
    if (fs.existsSync(dexFile)) {
      fs.unlinkSync(dexFile)
    }
    return path.resolve(kotlinSrcOutDir, file)
  })
  // 解析未发生变化，但dex不存在的
  ;['index.kt', ...(result.chunks || [])].forEach((chunk) => {
    const chunkFile = path.resolve(kotlinSrcOutDir, chunk)
    if (!kotlinChangedFiles.includes(chunkFile)) {
      const dexFile = resolveDexByKotlinFile(kotlinDexOutDir, chunk)
      if (fs.existsSync(dexFile)) {
        // 如果缓存的dex文件存在，则不需要重新编译，但需要确定outputDir中存在dex文件
        const targetDexFile = resolveDexByKotlinFile(outputDir, chunk)
        if (!fs.existsSync(targetDexFile)) {
          fs.copySync(dexFile, targetDexFile)
        }
      } else {
        kotlinChangedFiles.push(chunkFile)
      }
    }
  })
  return kotlinChangedFiles
}

function syncDexList(
  dexList: string[],
  kotlinDexOutDir: string,
  outputDir: string
) {
  dexList.forEach((dex) => {
    const dexFile = path.resolve(kotlinDexOutDir, dex)
    const targetDexFile = path.resolve(outputDir, dex)
    fs.copySync(dexFile, targetDexFile)
  })
}

async function runKotlinDev(
  options: CompileAppOptions,
  result: RunKotlinDevResult
) {
  result.type = 'kotlin'
  const { inputDir, outputDir } = options
  const kotlinRootOutDir = kotlinDir(outputDir)
  const kotlinDexOutDir = kotlinDexDir(kotlinRootOutDir)
  const kotlinSrcOutDir = kotlinSrcDir(kotlinRootOutDir)
  const kotlinChangedFiles = parseKotlinChangedFiles(
    result,
    kotlinSrcOutDir,
    kotlinDexOutDir,
    outputDir
  )
  const kotlinMainFile = path.resolve(kotlinSrcOutDir, result.filename!)
  // 开发模式下，需要生成 dex
  if (kotlinChangedFiles.length && fs.existsSync(kotlinMainFile)) {
    const compilerServer = getCompilerServer<KotlinCompilerServer>(
      'uniapp-runextension'
    )
    if (!compilerServer) {
      throw `项目使用了uts插件，正在安装 uts Android 运行扩展...`
    }
    const {
      getDefaultJar,
      getKotlincHome,
      compile: compileDex,
    } = compilerServer

    const cacheDir = process.env.HX_DEPENDENCIES_DIR || ''

    const kotlinClassOutDir = kotlinClassDir(kotlinRootOutDir)
    const waiting = { done: undefined }
    const options = {
      version: 'v2',
      kotlinc: resolveKotlincArgs(
        kotlinChangedFiles,
        kotlinClassOutDir,
        getKotlincHome(),
        [kotlinClassOutDir].concat(
          getDefaultJar(2)
            .concat(getUniModulesCacheJars(cacheDir))
            .concat(getUniModulesJars(outputDir))
        )
      ).concat(['-module-name', `main-${+Date.now()}`]),
      d8: D8_DEFAULT_ARGS,
      kotlinOutDir: kotlinClassOutDir,
      dexOutDir: kotlinDexOutDir,
      inputDir: kotlinSrcOutDir,
      stderrListener: createStderrListener(
        kotlinSrcOutDir,
        resolveUniAppXSourceMapPath(kotlinRootOutDir),
        waiting
      ),
    }
    result.kotlinc = true
    // console.log('DEX编译参数:', options)
    const { code, msg, data } = await compileDex(options, inputDir)
    // 等待 stderrListener 执行完毕
    if (waiting.done) {
      await waiting.done
    }
    // console.log('DEX编译结果:', code, data)
    if (!code && data) {
      result.changed = data.dexList
      syncDexList(data.dexList, kotlinDexOutDir, outputDir)
    } else {
      // 编译失败，需要调整缓存的 manifest.json
      if (result.changed.length) {
        const manifest = readKotlinManifestJson(kotlinSrcOutDir)
        if (manifest) {
          result.changed.forEach((file) => {
            delete manifest[file]
          })
          writeKotlinManifestJson(kotlinSrcOutDir, manifest)
        }
        result.changed = []
      }

      if (msg) {
        console.error(msg)
      }
    }
  }
  return result
}

async function runKotlinBuild(_options: CompileAppOptions, _result: UTSResult) {
  // TODO
}

function readKotlinManifestJson(
  kotlinSrcOutDir: string
): Record<string, string> | undefined {
  const file = path.resolve(kotlinSrcOutDir, '.manifest.json')
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
}

function writeKotlinManifestJson(
  kotlinSrcOutDir: string,
  manifest: Record<string, string>
) {
  fs.writeFileSync(
    path.resolve(kotlinSrcOutDir, '.manifest.json'),
    JSON.stringify(manifest)
  )
}
