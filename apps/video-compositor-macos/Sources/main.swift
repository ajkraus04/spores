import AppKit
import AVFoundation
import CoreImage
import CoreGraphics
import Foundation

struct SafeArea {
  let x: CGFloat
  let y: CGFloat
  let width: CGFloat
  let height: CGFloat
}

enum CompositorError: Error, CustomStringConvertible {
  case invalidArguments
  case missingVideoTrack(String)
  case missingBackground(String)
  case exportFailed(String)

  var description: String {
    switch self {
    case .invalidArguments:
      return "usage: spores-video-compositor-macos <input-mp4> <background-png> <output-mp4> <safe-x> <safe-y> <safe-width> <safe-height>"
    case .missingVideoTrack(let path):
      return "input video has no video track: \(path)"
    case .missingBackground(let path):
      return "background image could not be read: \(path)"
    case .exportFailed(let message):
      return message
    }
  }
}

func parseArguments(_ arguments: [String]) throws -> (URL, URL, URL, SafeArea) {
  guard arguments.count == 8,
    let safeX = Double(arguments[4]),
    let safeY = Double(arguments[5]),
    let safeWidth = Double(arguments[6]),
    let safeHeight = Double(arguments[7])
  else {
    throw CompositorError.invalidArguments
  }

  return (
    URL(fileURLWithPath: arguments[1]),
    URL(fileURLWithPath: arguments[2]),
    URL(fileURLWithPath: arguments[3]),
    SafeArea(x: safeX, y: safeY, width: safeWidth, height: safeHeight)
  )
}

func even(_ value: Int) -> Int {
  value % 2 == 0 ? value : value + 1
}

func displaySize(for track: AVAssetTrack) -> CGSize {
  let rect = CGRect(origin: .zero, size: track.naturalSize).applying(track.preferredTransform)
  return CGSize(width: abs(rect.width), height: abs(rect.height))
}

func fitRect(source: CGSize, safeArea: SafeArea, renderSize: CGSize) -> CGRect {
  let safeHeight = renderSize.height * safeArea.height
  let safeRect = CGRect(
    x: renderSize.width * safeArea.x,
    y: renderSize.height - (renderSize.height * safeArea.y) - safeHeight,
    width: renderSize.width * safeArea.width,
    height: safeHeight
  )
  let scale = min(safeRect.width / source.width, safeRect.height / source.height)
  let fittedSize = CGSize(width: source.width * scale, height: source.height * scale)
  return CGRect(
    x: safeRect.minX + (safeRect.width - fittedSize.width) / 2,
    y: safeRect.minY + (safeRect.height - fittedSize.height) / 2,
    width: fittedSize.width,
    height: fittedSize.height
  )
}

func normalizedTransform(track: AVAssetTrack) -> CGAffineTransform {
  let sourceRect = CGRect(origin: .zero, size: track.naturalSize)
  let transformedRect = sourceRect.applying(track.preferredTransform)

  var transform = track.preferredTransform
  transform = transform.translatedBy(x: -transformedRect.minX, y: -transformedRect.minY)
  return transform
}

func scaledBackground(_ image: CIImage, renderSize: CGSize) -> CIImage {
  let scale = max(renderSize.width / image.extent.width, renderSize.height / image.extent.height)
  let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
  let cropped = scaled.cropped(to: CGRect(
    x: (scaled.extent.width - renderSize.width) / 2,
    y: (scaled.extent.height - renderSize.height) / 2,
    width: renderSize.width,
    height: renderSize.height
  ))
  return cropped.transformed(by: CGAffineTransform(translationX: -cropped.extent.minX, y: -cropped.extent.minY))
}

func roundedMask(rect: CGRect, renderRect: CGRect, radius: CGFloat) -> CIImage? {
  guard let filter = CIFilter(name: "CIRoundedRectangleGenerator") else {
    return nil
  }
  filter.setValue(CIVector(cgRect: rect), forKey: "inputExtent")
  filter.setValue(radius, forKey: "inputRadius")
  return filter.outputImage?.cropped(to: renderRect)
}

func alphaBlend(foreground: CIImage, background: CIImage, mask: CIImage) -> CIImage {
  foreground.applyingFilter("CIBlendWithAlphaMask", parameters: [
    kCIInputBackgroundImageKey: background,
    kCIInputMaskImageKey: mask,
  ])
}

func shadowLayer(mask: CIImage, renderRect: CGRect) -> CIImage {
  let shiftedMask = mask
    .transformed(by: CGAffineTransform(translationX: 0, y: -14))
    .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 28])
    .cropped(to: renderRect)
  let shadowColor = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0.42)).cropped(to: renderRect)
  return alphaBlend(foreground: shadowColor, background: CIImage.empty(), mask: shiftedMask)
}

func borderLayer(rect: CGRect, renderRect: CGRect) -> CIImage {
  guard let outerMask = roundedMask(rect: rect, renderRect: renderRect, radius: 24),
    let innerMask = roundedMask(rect: rect.insetBy(dx: 1, dy: 1), renderRect: renderRect, radius: 23)
  else {
    return CIImage.empty()
  }
  let borderMask = outerMask.composited(over: innerMask.applyingFilter("CIColorInvert"))
  let color = CIImage(color: CIColor(red: 1, green: 1, blue: 1, alpha: 0.12)).cropped(to: renderRect)
  return alphaBlend(foreground: color, background: CIImage.empty(), mask: borderMask)
}

func composeFrame(
  pixelBuffer: CVPixelBuffer,
  sourceTransform: CGAffineTransform,
  targetRect: CGRect,
  sourceDisplaySize: CGSize,
  background: CIImage,
  renderRect: CGRect,
  context: CIContext,
  outputBuffer: CVPixelBuffer
) {
  let scale = targetRect.width / sourceDisplaySize.width
  let input = CIImage(cvPixelBuffer: pixelBuffer)
    .transformed(by: sourceTransform)
    .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    .transformed(by: CGAffineTransform(translationX: targetRect.minX, y: targetRect.minY))
    .cropped(to: renderRect)

  let mask = roundedMask(rect: targetRect, renderRect: renderRect, radius: 24)
  let shadow = mask.map { shadowLayer(mask: $0, renderRect: renderRect) } ?? CIImage.empty()
  let source = mask.map {
    alphaBlend(foreground: input, background: CIImage.empty(), mask: $0)
  } ?? input
  let border = borderLayer(rect: targetRect, renderRect: renderRect)
  let output = border
    .composited(over: source)
    .composited(over: shadow)
    .composited(over: background)
    .cropped(to: renderRect)

  context.render(output, to: outputBuffer, bounds: renderRect, colorSpace: CGColorSpaceCreateDeviceRGB())
}

func compose(inputURL: URL, backgroundURL: URL, outputURL: URL, safeArea: SafeArea) async throws {
  let asset = AVURLAsset(url: inputURL)
  let videoTracks = try await asset.loadTracks(withMediaType: .video)
  guard let sourceVideoTrack = videoTracks.first else {
    throw CompositorError.missingVideoTrack(inputURL.path)
  }

  guard let backgroundImage = NSImage(contentsOf: backgroundURL),
    let backgroundCgImage = backgroundImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else {
    throw CompositorError.missingBackground(backgroundURL.path)
  }

  let renderSize = CGSize(
    width: CGFloat(even(backgroundCgImage.width)),
    height: CGFloat(even(backgroundCgImage.height))
  )
  let sourceDisplaySize = displaySize(for: sourceVideoTrack)
  let targetRect = fitRect(source: sourceDisplaySize, safeArea: safeArea, renderSize: renderSize)
  let renderRect = CGRect(origin: .zero, size: renderSize)
  let background = scaledBackground(CIImage(cgImage: backgroundCgImage), renderSize: renderSize)
  let sourceTransform = normalizedTransform(track: sourceVideoTrack)
  let context = CIContext(options: [
    .workingColorSpace: CGColorSpaceCreateDeviceRGB(),
    .outputColorSpace: CGColorSpaceCreateDeviceRGB(),
  ])

  try? FileManager.default.removeItem(at: outputURL)
  let reader = try AVAssetReader(asset: asset)
  let readerOutput = AVAssetReaderTrackOutput(track: sourceVideoTrack, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  ])
  readerOutput.alwaysCopiesSampleData = false
  guard reader.canAdd(readerOutput) else {
    throw CompositorError.exportFailed("could not add video reader output")
  }
  reader.add(readerOutput)

  let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
  let bitrate = max(4_000_000, Int(renderSize.width * renderSize.height * 4))
  let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: Int(renderSize.width),
    AVVideoHeightKey: Int(renderSize.height),
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: bitrate,
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    ],
  ])
  writerInput.expectsMediaDataInRealTime = false
  guard writer.canAdd(writerInput) else {
    throw CompositorError.exportFailed("could not add video writer input")
  }
  writer.add(writerInput)

  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: writerInput, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: Int(renderSize.width),
    kCVPixelBufferHeightKey as String: Int(renderSize.height),
    kCVPixelBufferIOSurfacePropertiesKey as String: [:],
  ])

  guard reader.startReading() else {
    throw CompositorError.exportFailed("video reader failed to start: \(reader.error?.localizedDescription ?? "unknown error")")
  }
  guard writer.startWriting() else {
    throw CompositorError.exportFailed("video writer failed to start: \(writer.error?.localizedDescription ?? "unknown error")")
  }
  writer.startSession(atSourceTime: .zero)

  let queue = DispatchQueue(label: "spores.video-compositor.writer")
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    var completed = false
    var firstPresentationTime: CMTime?

    writerInput.requestMediaDataWhenReady(on: queue) {
      if completed {
        return
      }

      while writerInput.isReadyForMoreMediaData {
        guard let sampleBuffer = readerOutput.copyNextSampleBuffer() else {
          completed = true
          writerInput.markAsFinished()
          writer.finishWriting {
            if writer.status == .completed {
              continuation.resume()
            } else {
              let message = writer.error?.localizedDescription ?? reader.error?.localizedDescription ?? "unknown writer failure"
              continuation.resume(throwing: CompositorError.exportFailed("video composition failed: \(message)"))
            }
          }
          return
        }

        guard let inputBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
          let pool = adaptor.pixelBufferPool
        else {
          completed = true
          writerInput.markAsFinished()
          writer.cancelWriting()
          continuation.resume(throwing: CompositorError.exportFailed("could not access video pixel buffer"))
          return
        }

        var maybeOutputBuffer: CVPixelBuffer?
        let poolStatus = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &maybeOutputBuffer)
        guard poolStatus == kCVReturnSuccess, let outputBuffer = maybeOutputBuffer else {
          completed = true
          writerInput.markAsFinished()
          writer.cancelWriting()
          continuation.resume(throwing: CompositorError.exportFailed("could not allocate output pixel buffer"))
          return
        }

        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if firstPresentationTime == nil {
          firstPresentationTime = presentationTime
        }
        let outputTime = CMTimeSubtract(presentationTime, firstPresentationTime ?? .zero)
        composeFrame(
          pixelBuffer: inputBuffer,
          sourceTransform: sourceTransform,
          targetRect: targetRect,
          sourceDisplaySize: sourceDisplaySize,
          background: background,
          renderRect: renderRect,
          context: context,
          outputBuffer: outputBuffer
        )

        if !adaptor.append(outputBuffer, withPresentationTime: outputTime) {
          completed = true
          writerInput.markAsFinished()
          writer.cancelWriting()
          let message = writer.error?.localizedDescription ?? "unknown append failure"
          continuation.resume(throwing: CompositorError.exportFailed("video composition failed: \(message)"))
          return
        }
      }
    }
  }

  if reader.status == .failed {
    throw CompositorError.exportFailed("video reader failed: \(reader.error?.localizedDescription ?? "unknown error")")
  }
}

@main
struct SporesVideoCompositor {
  static func main() async {
    do {
      let (inputURL, backgroundURL, outputURL, safeArea) = try parseArguments(CommandLine.arguments)
      try await compose(inputURL: inputURL, backgroundURL: backgroundURL, outputURL: outputURL, safeArea: safeArea)
    } catch {
      FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
      Foundation.exit(1)
    }
  }
}
