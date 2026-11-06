use super::*;
use std::net::TcpListener;

fn fixture() -> (ConversationConnection,Rpc<TcpStream>,TcpListener) {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();
    let stream=TcpStream::connect(listener.local_addr().unwrap()).unwrap();stream.set_read_timeout(Some(Duration::from_millis(30))).unwrap();
    let control=ConversationConnection::new(Endpoint::Owned{address:String::new(),token:String::new(),job:Weak::new()},Arc::new(AtomicBool::new(false)));
    (control,Rpc{ws:WebSocket::from_raw_socket(stream,tungstenite::protocol::Role::Client,None),next_id:0,cancelled:None,deadline:None},listener)
}
fn request(socket: &mut WebSocket<TcpStream>) -> Value {loop {if let Message::Text(text)=socket.read().unwrap() {return serde_json::from_str(&text).unwrap();}}}
fn reply(socket: &mut WebSocket<TcpStream>,request: &Value,result: Value) {socket.send(Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).unwrap();}
fn start(listener: TcpListener,run: impl FnOnce(&mut WebSocket<TcpStream>)+Send+'static) -> JoinHandle<()> {
    thread::spawn(move || {
        let (stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        let mut socket=WebSocket::from_raw_socket(stream,tungstenite::protocol::Role::Server,None);
        let init=request(&mut socket);assert_eq!(init["method"],"initialize");reply(&mut socket,&init,json!({}));
        assert_eq!(request(&mut socket)["method"],"initialized");run(&mut socket);
    })
}
fn ack(value: Option<i64>,effective: Option<i64>) -> Value {json!({"settingsApplied":true,"threadSettings":{"modelContextWindow":value,"effectiveContextWindow":effective}})}
fn set(value: Option<i64>,expected: Option<i64>) -> ConversationRequest {ConversationRequest::SetContextWindow {model_context_window:value,expected_model_context_window:expected}}
fn run(control: &ConversationConnection,state: &mut State,rpc: &mut Rpc<TcpStream>,request: ConversationRequest) -> Result<Value,String> {
    exchange(&control.0,state,rpc,"original",request,&Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(2))
}

#[test]
fn fresh_context_connection_negotiates_experimental_api_before_settings_query() {
    let (control,mut rpc,listener)=fixture();
    let server=thread::spawn(move || {
        let (stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        let mut socket=WebSocket::from_raw_socket(stream,tungstenite::protocol::Role::Server,None);
        let init=request(&mut socket);assert_eq!(init["method"],"initialize");
        let experimental=init["params"]["capabilities"]["experimentalApi"].as_bool()==Some(true);
        reply(&mut socket,&init,json!({}));assert_eq!(request(&mut socket)["method"],"initialized");
        let read=request(&mut socket);assert_eq!(read["method"],SETTINGS);assert_eq!(read["params"],json!({"threadId":"original"}));
        // R37 rejects this experimental method before dispatch unless this
        // connection opted in; a permissive fixture hid the missing handshake.
        if experimental {reply(&mut socket,&read,ack(None,Some(258400)));} else {
            socket.send(Message::Text(json!({"id":read["id"],"error":{"code":-32600,"message":"thread/settings/update requires experimentalApi capability"}}).to_string().into())).unwrap();
        }
        assert!(socket.read().is_err(),"context query must not write or retry");
    });
    let mut state=State::default();let result=run(&control,&mut state,&mut rpc,ConversationRequest::ContextSettings);
    drop(rpc);server.join().unwrap();
    let value=result.unwrap();assert_eq!(value["supported"],true);assert_eq!(value["canChange"],true);
    assert_eq!(value["modelContextWindow"],Value::Null);assert_eq!(value["effectiveContextWindow"],258400);assert!(state.pending.is_none());
    assert!(!*control.0.input.lock().unwrap());assert!(!control.0.owned.load(Ordering::Acquire));assert!(control.0.worker.lock().unwrap().is_none());
}

#[test]
fn official_empty_and_unconfirmed_or_incomplete_responses_never_enable_writes() {
    for response in [json!({}),json!({"settingsApplied":true}),json!({"settingsApplied":false,"threadSettings":{"modelContextWindow":null,"effectiveContextWindow":1000}}),
        json!({"settingsApplied":"true","threadSettings":{"modelContextWindow":null,"effectiveContextWindow":1000}}),
        json!({"settingsApplied":true,"threadSettings":{"effectiveContextWindow":1000}}),
        json!({"settingsApplied":true,"threadSettings":{"modelContextWindow":null}}),ack(Some(-1),Some(1000))] {
        let (control,mut rpc,listener)=fixture();
        let server=start(listener,move |socket| {
            let read=request(socket);assert_eq!(read["method"],SETTINGS);assert_eq!(read["params"],json!({"threadId":"original"}));reply(socket,&read,response);
            assert!(socket.read().is_err(),"unsupported response must not be followed by a write");
        });
        let value=run(&control,&mut State::default(),&mut rpc,set(Some(900),None)).unwrap();assert_eq!(value["supported"],false);
        assert!(!*control.0.input.lock().unwrap());assert!(!control.0.owned.load(Ordering::Acquire));assert!(control.0.worker.lock().unwrap().is_none());
        drop(rpc);server.join().unwrap();
    }
}

#[test]
fn r36_reads_then_sets_only_thread_override_and_confirms_requested_and_effective_values() {
    for (value,expected,effective) in [(Some(1000),None,Some(950)),(None,Some(1000),Some(258400)),(Some(9007199254740991),None,Some(258400))] {
        let (control,mut rpc,listener)=fixture();
        let server=start(listener,move |socket| {
            let read=request(socket);assert_eq!(read["params"],json!({"threadId":"original"}));reply(socket,&read,ack(expected,Some(258400)));
            let write=request(socket);assert_eq!(write["method"],SETTINGS);assert_eq!(write["params"],json!({"threadId":"original","modelContextWindow":value}));reply(socket,&write,ack(value,effective));
        });
        let mut state=State::default();let result=run(&control,&mut state,&mut rpc,set(value,expected)).unwrap();
        assert_eq!(result["status"],"applied");assert_eq!(result["modelContextWindow"],json!(value));assert_eq!(result["effectiveContextWindow"],json!(effective));assert!(state.pending.is_none());
        assert!(!*control.0.input.lock().unwrap());assert!(!control.0.owned.load(Ordering::Acquire));server.join().unwrap();
    }
}

#[test]
fn stale_ui_is_rejected_before_write_and_unknown_ack_is_not_success() {
    let (control,mut rpc,listener)=fixture();let server=start(listener,|socket| {
        let read=request(socket);reply(socket,&read,ack(Some(2000),Some(1900)));assert!(socket.read().is_err());
    });
    let result=run(&control,&mut State::default(),&mut rpc,set(Some(1000),None)).unwrap();assert_eq!(result["status"],"conflict");drop(rpc);server.join().unwrap();
    for response in [json!({}),ack(Some(2000),Some(1900))] {
        let (control,mut rpc,listener)=fixture();let server=start(listener,move |socket| {
            let read=request(socket);reply(socket,&read,ack(None,Some(258400)));let write=request(socket);reply(socket,&write,response);
        });
        let mut state=State::default();let result=run(&control,&mut state,&mut rpc,set(Some(1000),None)).unwrap();assert_eq!(result["status"],"unknown");assert_eq!(state.pending,Some(Some(1000)));server.join().unwrap();
    }
}

#[test]
fn unknown_write_blocks_resubmission_and_authoritative_matching_query_recovers() {
    for (actual,allowed) in [(None,false),(Some(1000),true)] {
        let (control,mut rpc,listener)=fixture();let server=start(listener,move |socket| {
            let read=request(socket);reply(socket,&read,ack(actual,Some(950)));assert!(socket.read().is_err(),"query must not retry a mutation");
        });
        let mut state=State {thread:Some("original".into()),pending:Some(Some(1000))};
        let result=run(&control,&mut state,&mut rpc,ConversationRequest::ContextSettings).unwrap();assert_eq!(result["canChange"],allowed);assert_eq!(state.pending.is_none(),allowed);drop(rpc);server.join().unwrap();
    }
    let (control,mut rpc,listener)=fixture();let server=start(listener,|socket| {
        let read=request(socket);reply(socket,&read,ack(None,Some(258400)));assert!(socket.read().is_err(),"unknown mutation cannot be resent");
    });
    let mut state=State {thread:Some("original".into()),pending:Some(Some(1000))};
    let result=run(&control,&mut state,&mut rpc,set(Some(1000),None)).unwrap();assert_eq!(result["status"],"unknown");drop(rpc);server.join().unwrap();
}

#[test]
fn lost_ack_preserves_unknown_and_cancelled_session_does_not_write() {
    let (control,mut rpc,listener)=fixture();let server=start(listener,|socket| {
        let read=request(socket);reply(socket,&read,ack(None,Some(258400)));let write=request(socket);
        assert_eq!(write["params"]["modelContextWindow"],1000);
        // Close after a real write was received, before its acknowledgement.
    });
    let mut state=State::default();assert!(run(&control,&mut state,&mut rpc,set(Some(1000),None)).is_err());assert_eq!(state.pending,Some(Some(1000)));server.join().unwrap();
    let (control,mut rpc,listener)=fixture();let stopped=control.0.stopped.clone();let server=start(listener,move |socket| {
        let read=request(socket);stopped.store(true,Ordering::Release);reply(socket,&read,ack(None,Some(258400)));assert!(socket.read().is_err(),"stop before mutation must not send it");
    });
    let mut state=State::default();assert!(run(&control,&mut state,&mut rpc,set(Some(1000),None)).is_err());assert!(state.pending.is_none());drop(rpc);server.join().unwrap();
}

#[test]
fn exact_protocol_rejections_release_unknown_but_internal_errors_do_not() {
    for (code,unknown) in [(-32600,false),(-32601,false),(-32602,false),(-32603,true)] {
        let (control,mut rpc,listener)=fixture();let server=start(listener,move |socket| {
            let read=request(socket);reply(socket,&read,ack(None,Some(258400)));let write=request(socket);
            socket.send(Message::Text(json!({"id":write["id"],"error":{"code":code,"message":"fixture rejection"}}).to_string().into())).unwrap();
        });
        let mut state=State::default();let result=run(&control,&mut state,&mut rpc,set(Some(1000),None));
        if unknown {assert!(result.is_err());} else {let result=result.unwrap();assert_eq!(result["status"],"rejected");assert_eq!(result["canChange"],true);}
        assert_eq!(state.pending.is_some(),unknown);server.join().unwrap();
    }
}

#[test]
fn invalid_or_missing_nullable_fields_are_rejected_and_sessions_do_not_share_locks() {
    for value in [Some(0),Some(-1),Some(MAX_CONTEXT_INTEGER+1)] {assert!(validate_window(value).is_err());}
    assert!(serde_json::from_value::<ConversationRequest>(json!({"type":"setContextWindow","modelContextWindow":null})).is_err());
    assert!(serde_json::from_value::<ConversationRequest>(json!({"type":"setContextWindow","modelContextWindow":1.5,"expectedModelContextWindow":null})).is_err());
    assert!(serde_json::from_value::<ConversationRequest>(json!({"type":"setContextWindow","modelContextWindow":null,"expectedModelContextWindow":null})).is_ok());
    let (a,_rpc,_listener)=fixture();let (b,_rpc_b,_listener_b)=fixture();let _active=a.0.context_settings.lock().unwrap();
    assert!(a.context_settings_request("original",ConversationRequest::ContextSettings).unwrap_err().contains("이미 진행"));assert!(b.0.context_settings.try_lock().is_ok());
    b.0.stopped.store(true,Ordering::Release);assert!(b.context_settings_request("original",ConversationRequest::ContextSettings).is_err());
}
