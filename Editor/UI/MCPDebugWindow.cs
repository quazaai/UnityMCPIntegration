using UnityEditor;
using UnityEditor.UIElements;
using UnityEngine;
using UnityEngine.UIElements;
using System;
using System.Collections.Generic;

namespace Plugins.GamePilot.Editor.MCP
{
    public class MCPDebugWindow : EditorWindow
    {
        [SerializeField]
        private VisualTreeAsset uxml;
        [SerializeField]
        private StyleSheet uss;

        [SerializeField]
        private VisualTreeAsset m_VisualTreeAsset = default;
        
        private Label connectionStatusLabel;
        private Button connectButton;
        private Button disconnectButton;
        private Toggle autoReconnectToggle;
        // Removed serverUrlField completely
        private TextField serverPortField;
        
        // Component logging toggles
        private Dictionary<string, Toggle> logToggles = new Dictionary<string, Toggle>();
        
        // Connection info labels
        private Label lastErrorLabel;
        private Label connectionTimeLabel;
        
        // Statistics elements
        private Label messagesSentLabel;
        private Label messagesReceivedLabel;
        private Label reconnectAttemptsLabel;
        
        // Statistics counters
        private int messagesSent = 0;
        private int messagesReceived = 0;
        private int reconnectAttempts = 0;
        private DateTime? connectionStartTime = null;
        
        [MenuItem("Window/MCP Debug")]
        public static void ShowWindow()
        {
            MCPDebugWindow wnd = GetWindow<MCPDebugWindow>();
            wnd.titleContent = new GUIContent("MCP Debug");
            wnd.minSize = new Vector2(400, 500);
        }

        /// <summary>
        /// Initializes the debug window UI by loading visual assets, configuring UI elements, and binding event callbacks.
        /// </summary>
        /// <remarks>
        /// This method clones the UXML layout into the window's root element and applies styling from the USS asset.
        /// It queries essential UI components such as connection status labels, buttons, toggles, and text fields, and sets 
        /// a default server port value ("5010") if the port field is empty. Additionally, it binds events for connection, 
        /// disconnection, and auto-reconnect functionalities, sets up logging toggles, updates the UI to reflect the current state,
        /// and registers an editor update callback. If either the UXML or USS asset is missing, an error is logged for debugging purposes.
        /// </remarks>
        public void CreateGUI()
        {
            VisualElement root = rootVisualElement;
            
            if (uxml != null)
            {
                uxml.CloneTree(root);
            }
            else
            {
                Debug.LogError("VisualTreeAsset not found. Please check the path.");
            }
            
            if (uss != null)
            {
                root.styleSheets.Add(uss);
            } else
            {
                Debug.LogError("StyleSheet not found. Please check the path.");
            }
            
            // Get UI elements
            connectionStatusLabel = root.Q<Label>("connection-status");
            connectButton = root.Q<Button>("connect-button");
            disconnectButton = root.Q<Button>("disconnect-button");
            autoReconnectToggle = root.Q<Toggle>("auto-reconnect-toggle");
            serverPortField = root.Q<TextField>("server-port-field");
            
            lastErrorLabel = root.Q<Label>("last-error-value");
            connectionTimeLabel = root.Q<Label>("connection-time-value");
            
            messagesSentLabel = root.Q<Label>("messages-sent-value");
            messagesReceivedLabel = root.Q<Label>("messages-received-value");
            reconnectAttemptsLabel = root.Q<Label>("reconnect-attempts-value");
            
            // Set default port if empty
            if (serverPortField != null && string.IsNullOrWhiteSpace(serverPortField.value))
            {
                serverPortField.value = "5010";
            }
            
            // Setup UI events
            connectButton.clicked += OnConnectClicked;
            disconnectButton.clicked += OnDisconnectClicked;
            autoReconnectToggle.RegisterValueChangedCallback(OnAutoReconnectChanged);
            
            // Setup component logging toggles
            SetupComponentLoggingToggles(root);
            
            // Initialize UI with current state
            UpdateUIFromState();
            
            // Register for updates
            EditorApplication.update += OnEditorUpdate;
        }
        
        /// <summary>
        /// Creates a fallback user interface for the MCP Debug Window when the UXML layout is unavailable.
        /// </summary>
        /// <remarks>
        /// This method builds a basic UI on the provided root element that includes a notification label about the missing UXML, a text field for entering the server port (default value "5010"), buttons to initiate connection and disconnection, a toggle for auto-reconnect functionality, and a label to display connection status.
        /// </remarks>
        /// <param name="root">The container to which the fallback UI elements are added.</param>
        private void CreateFallbackUI(VisualElement root)
        {
            // Create a simple fallback UI if UXML fails to load
            root.Add(new Label("MCP Debug Window - UXML not found") { style = { fontSize = 16, marginBottom = 10 } });
            
            // Removed serverUrlField - only using port field as requested
            
            serverPortField = new TextField("Port (Default: 5010)") { value = "5010" };
            root.Add(serverPortField);
            
            var connectButton = new Button(OnConnectClicked) { text = "Connect" };
            root.Add(connectButton);
            
            var disconnectButton = new Button(OnDisconnectClicked) { text = "Disconnect" };
            root.Add(disconnectButton);
            
            var autoReconnectToggle = new Toggle("Auto Reconnect");
            autoReconnectToggle.RegisterValueChangedCallback(OnAutoReconnectChanged);
            root.Add(autoReconnectToggle);
            
            connectionStatusLabel = new Label("Status: Not Connected");
            root.Add(connectionStatusLabel);
        }
        
        private void SetupComponentLoggingToggles(VisualElement root)
        {
            var loggingContainer = root.Q<VisualElement>("logging-container");
            
            // Register MCPDebugWindow as a component for logging
            MCPLogger.InitializeComponent("MCPDebugWindow", false);
            
            // Global logging toggle
            var globalToggle = new Toggle("Enable All Logging");
            globalToggle.value = MCPLogger.GlobalLoggingEnabled;
            globalToggle.RegisterValueChangedCallback(evt => {
                MCPLogger.GlobalLoggingEnabled = evt.newValue;
                
                // First make sure all components are properly initialized before updating UI
                EnsureComponentsInitialized();
                
                // Update all component toggles to show they're enabled/disabled
                foreach (var componentName in MCPLogger.GetRegisteredComponents())
                {
                    if (logToggles.TryGetValue(componentName, out var toggle))
                    {
                        // Don't disable the toggle UI, just update its interactable state
                        toggle.SetEnabled(true);
                    }
                }
            });
            loggingContainer.Add(globalToggle);
            
            // Add a separator
            var separator = new VisualElement();
            separator.style.height = 1;
            separator.style.marginTop = 5;
            separator.style.marginBottom = 5;
            separator.style.backgroundColor = new Color(0.3f, 0.3f, 0.3f);
            loggingContainer.Add(separator);
            
            // Ensure all components are initialized
            EnsureComponentsInitialized();
            
            // Create toggles for standard components
            string[] standardComponents = {
                "MCPManager",
                "MCPConnectionManager",
                "MCPDataCollector",
                "MCPMessageHandler",
                "MCPCodeExecutor",
                "MCPMessageSender",
                "MCPDebugWindow"  // Add the debug window itself
            };
            
            foreach (string componentName in standardComponents)
            {
                CreateLoggingToggle(loggingContainer, componentName, $"Enable {componentName} logging");
            }
            
            // Add any additional registered components not in our standard list
            foreach (var componentName in MCPLogger.GetRegisteredComponents())
            {
                if (!logToggles.ContainsKey(componentName))
                {
                    CreateLoggingToggle(loggingContainer, componentName, $"Enable {componentName} logging");
                }
            }
        }
        
        // Make sure all components are initialized in the logger
        private void EnsureComponentsInitialized()
        {
            string[] standardComponents = {
                "MCPManager",
                "MCPConnectionManager",
                "MCPDataCollector",
                "MCPMessageHandler",
                "MCPCodeExecutor",
                "MCPMessageSender",
                "MCPDebugWindow"
            };
            
            foreach (string componentName in standardComponents)
            {
                MCPLogger.InitializeComponent(componentName, false);
            }
        }
        
        private void CreateLoggingToggle(VisualElement container, string componentName, string label)
        {
            var toggle = new Toggle(label);
            toggle.value = MCPLogger.GetComponentLoggingEnabled(componentName);
            
            // Make all toggles interactive, they'll work based on global enabled state
            toggle.SetEnabled(true);
            
            toggle.RegisterValueChangedCallback(evt => OnLoggingToggleChanged(componentName, evt.newValue));
            container.Add(toggle);
            logToggles[componentName] = toggle;
        }
        
        private void OnLoggingToggleChanged(string componentName, bool enabled)
        {
            MCPLogger.SetComponentLoggingEnabled(componentName, enabled);
        }
        
        /// <summary>
        /// Initiates a connection attempt when the connect button is clicked.
        /// </summary>
        /// <remarks>
        /// Retrieves and validates the server port from the input field, defaulting to "5010" if empty,
        /// and constructs a WebSocket URI using localhost and the specified port. If a MCPConnectionManager
        /// instance is found, its internal server URI is updated via reflection. Depending on the MCPManager’s
        /// initialization state, the method either retries an existing connection or initializes a new connection,
        /// updating the UI state accordingly. Displays a dialog for invalid port input or connection errors.
        /// </remarks>
        private void OnConnectClicked()
        {
            // Always use localhost for the WebSocket URL
            string serverUrl = "ws://localhost";
            
            // Get the server port from the text field
            string portText = serverPortField.value;
            
            // If port is empty, default to 5010
            if (string.IsNullOrWhiteSpace(portText))
            {
                portText = "5010";
                serverPortField.value = portText;
            }
            
            // Validate port format
            if (!int.TryParse(portText, out int port) || port < 1 || port > 65535)
            {
                EditorUtility.DisplayDialog("Invalid Port", 
                    "Please enter a valid port number between 1 and 65535.", "OK");
                return;
            }
            
            try {
                // Create the WebSocket URL with the specified port
                Uri uri = new Uri($"{serverUrl}:{port}");
                
                // If we have access to the ConnectionManager, try to update its server URI
                var connectionManager = GetConnectionManager();
                if (connectionManager != null)
                {
                    // Use reflection to set the serverUri field if it exists
                    var serverUriField = typeof(MCPConnectionManager).GetField("serverUri", 
                        System.Reflection.BindingFlags.NonPublic | 
                        System.Reflection.BindingFlags.Instance);
                        
                    if (serverUriField != null)
                    {
                        serverUriField.SetValue(connectionManager, uri);
                    }
                }
                
                // Initiate manual connection
                if (MCPManager.IsInitialized)
                {
                    MCPManager.RetryConnection();
                    connectionStartTime = DateTime.Now;
                    UpdateUIFromState();
                }
                else
                {
                    MCPManager.Initialize();
                    connectionStartTime = DateTime.Now;
                    UpdateUIFromState();
                }
            }
            catch (UriFormatException)
            {
                EditorUtility.DisplayDialog("Invalid URL", 
                    "The URL format is invalid.", "OK");
            }
            catch (Exception ex)
            {
                EditorUtility.DisplayDialog("Connection Error", 
                    $"Error connecting to server: {ex.Message}", "OK");
            }
        }
        
        private void OnDisconnectClicked()
        {
            if (MCPManager.IsInitialized)
            {
                MCPManager.Shutdown();
                connectionStartTime = null;
                UpdateUIFromState();
            }
        }
        
        private void OnAutoReconnectChanged(ChangeEvent<bool> evt)
        {
            if (MCPManager.IsInitialized)
            {
                MCPManager.EnableAutoReconnect(evt.newValue);
            }
        }
        
        private void OnEditorUpdate()
        {
            // Update connection status and statistics
            UpdateUIFromState();
        }
        
        private void UpdateUIFromState()
        {
            bool isInitialized = MCPManager.IsInitialized;
            bool isConnected = MCPManager.IsConnected;
            
            // Only log status if logging is enabled
            if (MCPLogger.IsLoggingEnabled("MCPDebugWindow"))
            {
                Debug.Log($"[MCP] [MCPDebugWindow] Status check: IsInitialized={isInitialized}, IsConnected={isConnected}");
            }
            
            // Update status label
            if (!isInitialized)
            {
                connectionStatusLabel.text = "Not Initialized";
                connectionStatusLabel.RemoveFromClassList("status-connected");
                connectionStatusLabel.RemoveFromClassList("status-connecting");
                connectionStatusLabel.AddToClassList("status-disconnected");
            }
            else if (isConnected)
            {
                connectionStatusLabel.text = "Connected";
                connectionStatusLabel.RemoveFromClassList("status-disconnected");
                connectionStatusLabel.RemoveFromClassList("status-connecting");
                connectionStatusLabel.AddToClassList("status-connected");
                
                // If we're in the connected state, make sure connectionStartTime is set
                // This ensures the timer works properly
                if (!connectionStartTime.HasValue)
                {
                    connectionStartTime = DateTime.Now;
                }
            }
            else
            {
                connectionStatusLabel.text = "Disconnected";
                connectionStatusLabel.RemoveFromClassList("status-connected");
                connectionStatusLabel.RemoveFromClassList("status-connecting");
                connectionStatusLabel.AddToClassList("status-disconnected");
                
                // Reset connection time when disconnected
                connectionStartTime = null;
            }
            
            // Update button states
            connectButton.SetEnabled(!isConnected);
            disconnectButton.SetEnabled(isInitialized);
            serverPortField.SetEnabled(!isConnected); // Only allow port changes when disconnected
            
            // Update connection time if connected
            if (connectionStartTime.HasValue && isConnected)
            {
                TimeSpan duration = DateTime.Now - connectionStartTime.Value;
                connectionTimeLabel.text = $"{duration.Hours:00}:{duration.Minutes:00}:{duration.Seconds:00}";
            }
            else
            {
                connectionTimeLabel.text = "00:00:00";
            }
            
            // Update statistics if available
            if (isInitialized)
            {
                // Get connection statistics
                var connectionManager = GetConnectionManager();
                if (connectionManager != null)
                {
                    messagesSentLabel.text = connectionManager.MessagesSent.ToString();
                    messagesReceivedLabel.text = connectionManager.MessagesReceived.ToString();
                    reconnectAttemptsLabel.text = connectionManager.ReconnectAttempts.ToString();
                    lastErrorLabel.text = !string.IsNullOrEmpty(connectionManager.LastErrorMessage) 
                        ? connectionManager.LastErrorMessage : "None";
                }
                else
                {
                    messagesSentLabel.text = "0";
                    messagesReceivedLabel.text = "0";
                    reconnectAttemptsLabel.text = "0";
                    lastErrorLabel.text = "None";
                }
            }
        }
        
        // Helper to access connection manager through reflection if needed
        private MCPConnectionManager GetConnectionManager()
        {
            if (!MCPManager.IsInitialized)
                return null;
                
            // Try to access the connection manager using reflection
            try
            {
                var managerType = typeof(MCPManager);
                var field = managerType.GetField("connectionManager", 
                    System.Reflection.BindingFlags.NonPublic | 
                    System.Reflection.BindingFlags.Static);
                    
                if (field != null)
                {
                    return field.GetValue(null) as MCPConnectionManager;
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"Error accessing connection manager: {ex.Message}");
            }
            
            return null;
        }
        
        private void OnDisable()
        {
            // Unregister from editor updates
            EditorApplication.update -= OnEditorUpdate;
        }
    }
}
