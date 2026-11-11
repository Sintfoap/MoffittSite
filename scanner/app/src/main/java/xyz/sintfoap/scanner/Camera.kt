package xyz.sintfoap.scanner

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors

/** The camera, once it's allowed: its preview, with whatever else it's doing (`useCases`). */
@Composable
fun CameraView(modifier: Modifier = Modifier, useCases: () -> List<UseCase>) {
    val context = LocalContext.current
    var allowed by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var asked by remember { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it; asked = true }
    LaunchedEffect(Unit) { if (!allowed) ask.launch(Manifest.permission.CAMERA) }
    if (!allowed) {
        Column(modifier.padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text(if (asked) "The scanner needs the camera. Allow it in Settings → Apps → Pantry scanner → Permissions." else "Asking for the camera…", color = Ink)
        }
        return
    }
    val owner = LocalLifecycleOwner.current
    val preview = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    DisposableEffect(owner) {
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        future.addListener({
            provider = future.get()
            val p = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
            provider?.unbindAll()
            provider?.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, p, *useCases().toTypedArray())
        }, ContextCompat.getMainExecutor(context))
        onDispose { provider?.unbindAll() }
    }
    AndroidView({ preview }, modifier.fillMaxSize())
}

private val analysisThread = Executors.newSingleThreadExecutor()

/** Barcodes (and QR codes) the camera sees, one frame at a time: `found` gets each frame's codes. */
@SuppressLint("UnsafeOptInUsageError")
fun barcodeAnalysis(qr: Boolean, found: (List<String>) -> Unit): ImageAnalysis {
    val formats = if (qr) intArrayOf(Barcode.FORMAT_QR_CODE)
        else intArrayOf(Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E)
    val scanner = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(formats[0], *formats.drop(1).toIntArray()).build())
    return analysis { image, done ->
        scanner.process(image).addOnSuccessListener { codes -> found(codes.mapNotNull { it.rawValue }) }.addOnCompleteListener { done() }
    }
}

@SuppressLint("UnsafeOptInUsageError")
private fun analysis(read: (InputImage, () -> Unit) -> Unit): ImageAnalysis {
    val a = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
    a.setAnalyzer(analysisThread) { proxy: ImageProxy ->
        val media = proxy.image
        if (media == null) { proxy.close(); return@setAnalyzer }
        read(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)) { proxy.close() }
    }
    return a
}

/** Takes a picture into the app's cache: `done` gets the file, or an error to say. */
fun snap(context: Context, capture: ImageCapture, done: (File?, String?) -> Unit) {
    val file = File(context.cacheDir, "receipt-${System.currentTimeMillis()}.jpg")
    capture.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(context),
        object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(output: ImageCapture.OutputFileResults) = done(file, null)
            override fun onError(e: ImageCaptureException) = done(null, e.message ?: "the camera couldn't take it")
        })
}

/** A photo, the right way up, at most 1568 px across (more than the site's readers use), as base64 JPEG. */
fun shrunk(file: File, side: Int = 1568): String {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= side) sample *= 2
    var bmp = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    val turn = when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90f; ExifInterface.ORIENTATION_ROTATE_180 -> 180f; ExifInterface.ORIENTATION_ROTATE_270 -> 270f; else -> 0f
    }
    val scale = minOf(1f, side.toFloat() / maxOf(bmp.width, bmp.height))
    if (turn != 0f || scale < 1f) {
        val m = Matrix().apply { postScale(scale, scale); postRotate(turn) }
        bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
    }
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}
