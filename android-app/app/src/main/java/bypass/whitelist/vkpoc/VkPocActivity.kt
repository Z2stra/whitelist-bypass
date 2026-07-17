package bypass.whitelist.vkpoc

import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import bypass.whitelist.BuildConfig
import bypass.whitelist.R
import bypass.whitelist.vkpoc.core.VkPocCoordinator
import bypass.whitelist.vkpoc.core.VkPocError
import bypass.whitelist.vkpoc.core.VkPocUiState
import com.google.android.material.button.MaterialButton
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/** Isolated status-only screen for the official VK API transport POC. */
class VkPocActivity : AppCompatActivity() {
    private val viewModel: VkPocViewModel by viewModels {
        VkPocViewModelFactory(
            configured = BuildConfig.VK_POC_CONFIGURED,
            groupId = BuildConfig.VK_POC_GROUP_ID,
        )
    }

    private lateinit var statusText: TextView
    private lateinit var detailText: TextView
    private lateinit var progress: ProgressBar
    private lateinit var loginButton: MaterialButton
    private lateinit var refreshButton: MaterialButton
    private lateinit var sendButton: MaterialButton
    private lateinit var cancelButton: MaterialButton
    private lateinit var logoutButton: MaterialButton

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_vk_poc)
        bindViews()
        applySystemBarInsets()
        bindActions()

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.uiState.collect(::render)
            }
        }
    }

    private fun bindViews() {
        statusText = findViewById(R.id.vkPocStatusText)
        detailText = findViewById(R.id.vkPocDetailText)
        progress = findViewById(R.id.vkPocProgress)
        loginButton = findViewById(R.id.vkPocLoginButton)
        refreshButton = findViewById(R.id.vkPocRefreshButton)
        sendButton = findViewById(R.id.vkPocSendButton)
        cancelButton = findViewById(R.id.vkPocCancelButton)
        logoutButton = findViewById(R.id.vkPocLogoutButton)
    }

    private fun applySystemBarInsets() {
        val root = findViewById<View>(R.id.vkPocRoot)
        val initialLeft = root.paddingLeft
        val initialTop = root.paddingTop
        val initialRight = root.paddingRight
        val initialBottom = root.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(
                initialLeft + bars.left,
                initialTop + bars.top,
                initialRight + bars.right,
                initialBottom + bars.bottom,
            )
            insets
        }
    }

    private fun bindActions() {
        findViewById<View>(R.id.vkPocBackButton).setOnClickListener { finish() }
        loginButton.setOnClickListener { viewModel.authorize() }
        refreshButton.setOnClickListener { viewModel.refresh() }
        sendButton.setOnClickListener { viewModel.runExchange() }
        cancelButton.setOnClickListener { viewModel.cancelExchange() }
        logoutButton.setOnClickListener { viewModel.logout() }
    }

    private fun render(state: VkPocUiState) {
        progress.isVisible = state.isBusy()
        loginButton.isVisible = false
        refreshButton.isVisible = false
        sendButton.isVisible = false
        cancelButton.isVisible = false
        logoutButton.isVisible = false

        when (state) {
            VkPocUiState.SignedOut -> {
                setStatus(R.string.vk_poc_status_signed_out, R.string.vk_poc_detail_signed_out)
                loginButton.isVisible = true
            }
            VkPocUiState.Authorizing ->
                setStatus(R.string.vk_poc_status_authorizing, R.string.vk_poc_detail_authorizing)
            VkPocUiState.Refreshing ->
                setStatus(R.string.vk_poc_status_refreshing, R.string.vk_poc_detail_refreshing)
            VkPocUiState.SigningOut ->
                setStatus(R.string.vk_poc_status_signing_out, R.string.vk_poc_detail_signing_out)
            VkPocUiState.Authorized -> {
                setStatus(R.string.vk_poc_status_authorized, R.string.vk_poc_detail_authorized)
                showAuthorizedActions()
            }
            VkPocUiState.Sending -> {
                setStatus(R.string.vk_poc_status_sending, R.string.vk_poc_detail_sending)
                cancelButton.isVisible = true
            }
            VkPocUiState.WaitingForPong -> {
                setStatus(R.string.vk_poc_status_waiting, R.string.vk_poc_detail_waiting)
                cancelButton.isVisible = true
            }
            is VkPocUiState.Success -> {
                statusText.setText(R.string.vk_poc_status_success)
                detailText.text = getString(R.string.vk_poc_detail_success, state.elapsedMillis)
                showAuthorizedActions()
            }
            VkPocUiState.Timeout -> {
                setStatus(R.string.vk_poc_status_timeout, R.string.vk_poc_detail_timeout)
                showAuthorizedActions()
            }
            VkPocUiState.Cancelled -> {
                setStatus(R.string.vk_poc_status_cancelled, R.string.vk_poc_detail_cancelled)
                showAuthorizedActions()
            }
            is VkPocUiState.Error -> renderError(state.error)
        }
    }

    private fun renderError(error: VkPocError) {
        statusText.setText(R.string.vk_poc_status_error)
        detailText.setText(error.toStringResource())
        when (error) {
            VkPocError.INVALID_COMMUNITY_ID -> Unit
            VkPocError.VK_SCOPE_MISSING -> logoutButton.isVisible = true
            VkPocError.AUTHENTICATION_REQUIRED -> {
                loginButton.isVisible = true
                logoutButton.isVisible = true
            }
            VkPocError.AUTH_REFRESH_FAILED -> {
                loginButton.isVisible = true
                refreshButton.isVisible = true
                logoutButton.isVisible = true
            }
            else -> showAuthorizedActions()
        }
    }

    private fun showAuthorizedActions() {
        refreshButton.isVisible = true
        sendButton.isVisible = true
        logoutButton.isVisible = true
    }

    private fun setStatus(status: Int, detail: Int) {
        statusText.setText(status)
        detailText.setText(detail)
    }

    private fun VkPocUiState.isBusy(): Boolean =
        this is VkPocUiState.Authorizing ||
            this is VkPocUiState.Refreshing ||
            this is VkPocUiState.SigningOut ||
            this is VkPocUiState.Sending ||
            this is VkPocUiState.WaitingForPong

    private fun VkPocError.toStringResource(): Int =
        when (this) {
            VkPocError.INVALID_COMMUNITY_ID -> R.string.vk_poc_error_config_missing
            VkPocError.VK_SCOPE_MISSING -> R.string.vk_poc_error_scope_missing
            VkPocError.AUTHENTICATION_REQUIRED -> R.string.vk_poc_error_relogin_required
            VkPocError.AUTH_REFRESH_FAILED -> R.string.vk_poc_error_auth_failed
            VkPocError.NETWORK_UNAVAILABLE -> R.string.vk_poc_error_network
            VkPocError.RATE_LIMITED -> R.string.vk_poc_error_rate_limited
            VkPocError.VALIDATION_REQUIRED -> R.string.vk_poc_error_captcha
            VkPocError.VK_API_REJECTED -> R.string.vk_poc_error_access_denied
            VkPocError.MALFORMED_RESPONSE -> R.string.vk_poc_error_protocol
            VkPocError.UNEXPECTED -> R.string.vk_poc_error_unknown
        }

    private class VkPocViewModelFactory(
        private val configured: Boolean,
        private val groupId: Long,
    ) : ViewModelProvider.Factory {
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            require(modelClass.isAssignableFrom(VkPocViewModel::class.java))
            val session = VkIdPocSessionController()
            val apiClient = VkPocHttpApiClient(
                expectedPeerId = -groupId,
                accessTokenProvider = session::requireMessagesAccessToken,
            )
            @Suppress("UNCHECKED_CAST")
            return VkPocViewModel(
                configured = configured,
                groupId = groupId,
                sessionController = session,
                coordinator = VkPocCoordinator(apiClient, session),
                monotonicClockMillis = SystemClock::elapsedRealtime,
            ) as T
        }
    }
}
