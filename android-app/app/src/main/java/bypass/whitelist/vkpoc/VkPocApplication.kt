package bypass.whitelist.vkpoc

import android.app.Application
import bypass.whitelist.BuildConfig
import com.vk.id.VKID

/** Minimal application boundary used by the signed, source-free POC artifact. */
class VkPocApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.VK_POC_CONFIGURED) {
            VKID.logsEnabled = false
            VKID.init(this)
        }
    }
}
