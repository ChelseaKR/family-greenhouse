package net.familygreenhouse.app.frame

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import net.familygreenhouse.app.R
import kotlin.math.roundToInt

// The frame's Compose surfaces. Every word on them comes from the web, in the
// app's language (config/nativeFrame.ts and friends); the only strings of the
// app's own are the system's back, search and clear descriptions, which
// AndroidX already carries in every language the app speaks.

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FrameTopBar(ui: FrameUiState, frame: NativeFrameController) {
    val top = ui.top ?: return
    val tools = ui.barTools
    val search = tools?.search
    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = FgColors.forest,
        ),
        navigationIcon = {
            if (ui.depth > 1 || ui.searchOpen) {
                IconButton(onClick = { frame.goBack() }) {
                    Icon(
                        painterResource(R.drawable.ic_fg_arrow_back),
                        contentDescription = stringResource(androidx.appcompat.R.string.abc_action_bar_up_description),
                    )
                }
            }
        },
        title = {
            if (ui.searchOpen && search != null) {
                SearchField(ui, frame, search.placeholder)
            } else {
                Text(
                    top.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = if (top.largeTitle) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.titleLarge,
                    fontWeight = if (top.largeTitle) FontWeight.SemiBold else FontWeight.Medium,
                    modifier = Modifier.semantics { heading() },
                )
            }
        },
        actions = {
            if (search != null && !ui.searchOpen) {
                IconButton(onClick = {
                    ui.searchOpen = true
                    frame.searchVisibilityChanged()
                }) {
                    Icon(
                        painterResource(R.drawable.ic_fg_search),
                        contentDescription = search.placeholder.ifEmpty {
                            stringResource(androidx.appcompat.R.string.abc_searchview_description_search)
                        },
                    )
                }
            }
            tools?.menus?.forEach { menu -> BarMenuButton(menu, frame) }
            top.rightButton?.let { button ->
                IconButton(onClick = { frame.rightButtonTapped(button.id) }) {
                    Icon(painterResource(NativeFrameIcons.forSymbol(button.symbol)), contentDescription = button.label)
                }
            }
        },
    )
}

@Composable
private fun SearchField(ui: FrameUiState, frame: NativeFrameController, placeholder: String) {
    val focus = remember { FocusRequester() }
    TextField(
        value = ui.searchText,
        onValueChange = { frame.searchChanged(it) },
        placeholder = { Text(placeholder, maxLines = 1) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = Color.Transparent,
            unfocusedContainerColor = Color.Transparent,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
        ),
        trailingIcon = {
            IconButton(onClick = {
                if (ui.searchText.isEmpty()) {
                    frame.closeSearch()
                    frame.searchVisibilityChanged()
                } else {
                    frame.searchChanged("")
                }
            }) {
                Icon(
                    painterResource(R.drawable.ic_fg_close),
                    contentDescription = stringResource(androidx.appcompat.R.string.abc_searchview_description_clear),
                )
            }
        },
        modifier = Modifier.fillMaxWidth().focusRequester(focus),
    )
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

@Composable
private fun BarMenuButton(menu: BarMenu, frame: NativeFrameController) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(painterResource(NativeFrameIcons.forBarMenu(menu.symbol)), contentDescription = menu.label)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            menu.groups.forEachIndexed { index, group ->
                if (index > 0) HorizontalDivider()
                group.title?.takeIf { it.isNotBlank() }?.let { title ->
                    Text(
                        title,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() },
                    )
                }
                group.items.forEach { item ->
                    DropdownMenuItem(
                        text = { Text(item.title) },
                        leadingIcon = if (item.checked != null) {
                            {
                                if (item.checked == true) {
                                    Icon(painterResource(R.drawable.ic_fg_check), contentDescription = null)
                                } else {
                                    Spacer(Modifier.size(24.dp))
                                }
                            }
                        } else null,
                        onClick = {
                            open = false
                            frame.barMenuPicked(item.id)
                        },
                        modifier = if (item.checked != null) {
                            Modifier.semantics { selected = item.checked == true }
                        } else Modifier,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FrameBottomBar(ui: FrameUiState, frame: NativeFrameController) {
    val config = ui.configuration ?: return
    // Material: the navigation bar goes while the keyboard is up.
    if (WindowInsets.isImeVisible) return
    // Paper, like the top app bar and the page, with a hairline above it.
    // On a WebView older than 140, Capacitor pads the whole window inside
    // the system bars, so the gesture bar's strip is the window's paper
    // background; a tinted bar would stop short of it.
    Column {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
            config.styles.forEach { tab ->
                val selected = tab.id == ui.selectedTab
                NavigationBarItem(
                    selected = selected,
                    onClick = { frame.selectTab(tab.id) },
                    icon = {
                        Icon(
                            painterResource(NativeFrameIcons.forSymbol(if (selected) tab.selectedSymbol else tab.symbol)),
                            contentDescription = null,
                        )
                    },
                    label = { Text(tab.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                )
            }
        }
    }
}

/** More's list, or Settings' list, in place of the page. */
@Composable
fun FrameListLayer(ui: FrameUiState, frame: NativeFrameController) {
    val (_, sections) = ui.nativeList ?: return
    Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxSize()) {
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            sections.forEachIndexed { index, section ->
                if (index > 0) item { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
                section.title?.takeIf { it.isNotBlank() }?.let { title ->
                    item {
                        Text(
                            title,
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp)
                                .semantics { heading() },
                        )
                    }
                }
                items(section.items, key = { it.id }) { row ->
                    val color = if (row.destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                    ListItem(
                        headlineContent = { Text(row.title, color = color) },
                        leadingContent = row.symbol?.let { symbol ->
                            {
                                Icon(
                                    painterResource(NativeFrameIcons.forSymbol(symbol)),
                                    contentDescription = null,
                                    tint = if (row.destructive) color else MaterialTheme.colorScheme.primary,
                                )
                            }
                        },
                        trailingContent = if (row.checked) {
                            { Icon(painterResource(R.drawable.ic_fg_check), contentDescription = null, tint = MaterialTheme.colorScheme.primary) }
                        } else null,
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                        modifier = Modifier
                            .heightIn(min = 56.dp)
                            .then(
                                if (row.checked) Modifier.selectable(selected = true, role = Role.RadioButton) { frame.moreItemChosen(row) }
                                else Modifier.clickable(role = Role.Button) { frame.moreItemChosen(row) }
                            ),
                    )
                }
            }
        }
    }
}

/** Alerts, action sheets, the sign-out confirmation and form sheets. */
@Composable
fun FrameDialogs(ui: FrameUiState, frame: NativeFrameController) {
    ui.alert?.let { alert ->
        if (alert.request.kind == PresentKind.ALERT) AlertFor(alert, frame) else ActionSheetFor(alert, frame)
    }
    ui.signOut?.let { item ->
        val config = ui.configuration
        AlertDialog(
            onDismissRequest = { frame.confirmSignOut(false) },
            title = { Text(config?.signOutTitle.orEmpty()) },
            confirmButton = {
                TextButton(onClick = { frame.confirmSignOut(true) }) {
                    Text(config?.signOutConfirm ?: item.title, color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { frame.confirmSignOut(false) }) { Text(config?.signOutCancel.orEmpty()) }
            },
        )
    }
    ui.form?.let { FormSheet(it, frame) }
}

@Composable
private fun AlertFor(alert: PresentedAlert, frame: NativeFrameController) {
    val request = alert.request
    val choices = request.choices
    AlertDialog(
        onDismissRequest = { frame.alertChose(alert, null) },
        title = alert.title?.let { { Text(it) } },
        text = alert.message?.let { { Text(it) } },
        confirmButton = {
            // Material puts the confirming button last; with several, they stack.
            Column(horizontalAlignment = Alignment.End) {
                choices.forEach { action ->
                    TextButton(onClick = { frame.alertChose(alert, action) }) {
                        Text(
                            action.title,
                            color = if (action.style == PresentActionStyle.DESTRUCTIVE) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
        },
        dismissButton = {
            TextButton(onClick = { frame.alertChose(alert, request.cancelAction) }) { Text(request.cancelAction.title) }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ActionSheetFor(alert: PresentedAlert, frame: NativeFrameController) {
    val request = alert.request
    ModalBottomSheet(
        onDismissRequest = { frame.alertChose(alert, null) },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 8.dp)) {
            alert.title?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() },
                )
            }
            alert.message?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
                )
            }
            request.choices.forEach { action ->
                ListItem(
                    headlineContent = {
                        Text(
                            action.title,
                            color = if (action.style == PresentActionStyle.DESTRUCTIVE) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurface,
                        )
                    },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.clickable(role = Role.Button) { frame.alertChose(alert, action) },
                )
            }
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            ListItem(
                headlineContent = { Text(request.cancelAction.title, fontWeight = FontWeight.Medium) },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                modifier = Modifier.clickable(role = Role.Button) { frame.alertChose(alert, request.cancelAction) },
            )
        }
    }
}

/** Add care task, and any other form the web sends: a Material modal bottom
 *  sheet with Cancel and the submit button in its own header. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FormSheet(form: PresentedForm, frame: NativeFrameController) {
    val request = form.request
    ModalBottomSheet(
        onDismissRequest = { frame.formCancel(form) },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false),
    ) {
        Column(Modifier.fillMaxWidth().imePadding()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            ) {
                TextButton(onClick = { frame.formCancel(form) }) { Text(request.cancel) }
                Text(
                    request.title,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp).semantics { heading() },
                    maxLines = 2,
                )
                TextButton(
                    onClick = { frame.formSubmit(form) },
                    enabled = request.canSubmit(form.values),
                ) { Text(request.submit, fontWeight = FontWeight.SemiBold) }
            }
            HorizontalDivider()
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                request.message?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                request.fields.filter { request.isVisible(it, form.values) }.forEach { field ->
                    FormField(field, form)
                }
                Spacer(Modifier.navigationBarsPadding())
            }
        }
    }
}

@Composable
private fun FormField(field: FormSheetField, form: PresentedForm) {
    when (field) {
        is FormSheetField.Choice -> {
            val current = (form.values[field.id] as? FormSheetValue.Words)?.text
            Column {
                FieldLabel(field.label)
                Column(Modifier.selectableGroup()) {
                    field.options.forEach { option ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .selectable(selected = option.id == current, role = Role.RadioButton) {
                                    form.values = form.values + (field.id to FormSheetValue.Words(option.id))
                                },
                        ) {
                            RadioButton(selected = option.id == current, onClick = null)
                            Text(option.title, modifier = Modifier.padding(start = 12.dp))
                        }
                    }
                }
            }
        }
        is FormSheetField.Stepper -> {
            val value = (form.values[field.id] as? FormSheetValue.Number)?.number ?: field.min
            val words = FormSheetRequest.stepperWords(field.one, field.other, value)
            fun set(next: Int) {
                form.values = form.values + (field.id to FormSheetValue.Number(next.coerceIn(field.min, field.max)))
            }
            Column {
                FieldLabel(field.label)
                // One adjustable control for TalkBack ("Every 3 days", swipe
                // up or down to change), the − and + for a finger.
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {
                        contentDescription = field.label
                        stateDescription = words
                        progressBarRangeInfo = ProgressBarRangeInfo(
                            value.toFloat(),
                            field.min.toFloat()..field.max.toFloat(),
                            steps = (field.max - field.min - 1).coerceAtLeast(0),
                        )
                        setProgress { target ->
                            set(target.roundToInt())
                            true
                        }
                    },
                ) {
                    Text(words, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    FilledTonalIconButton(
                        onClick = { set(value - 1) },
                        enabled = value > field.min,
                        modifier = Modifier.clearAndSetSemantics { },
                    ) { Icon(painterResource(R.drawable.ic_fg_remove), contentDescription = null) }
                    Spacer(Modifier.width(8.dp))
                    FilledTonalIconButton(
                        onClick = { set(value + 1) },
                        enabled = value < field.max,
                        modifier = Modifier.clearAndSetSemantics { },
                    ) { Icon(painterResource(R.drawable.ic_fg_add), contentDescription = null) }
                }
            }
        }
        is FormSheetField.Text -> {
            val text = (form.values[field.id] as? FormSheetValue.Words)?.text.orEmpty()
            OutlinedTextField(
                value = text,
                onValueChange = { form.values = form.values + (field.id to FormSheetValue.Words(it.take(field.maxLength))) },
                label = { Text(field.label) },
                placeholder = field.placeholder?.let { { Text(it) } },
                singleLine = !field.multiline,
                minLines = if (field.multiline) 3 else 1,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun FieldLabel(label: String) {
    Text(
        label,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 4.dp),
    )
}
