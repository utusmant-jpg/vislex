// Deterministic synthetic protocol fixture; never evaluates legal/factual accuracy.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
const port = Number(process.argv[2]);
let requests=0, hold=false;
const held=[], units=new Map(), calls=[],errors=[];
const tool=(name,args)=>({type:'function_call',call_id:randomUUID(),name,arguments:JSON.stringify(args)});
function respond(response,body) {
  requests++;
  const prompt=JSON.stringify(body.input ?? []);
  const unit=prompt.match(/(?:Internal case analysis unit|VisLex internal analysis unit) ([0-9a-f]{64})/i)?.[1];
  if (!unit) throw new Error('Fixture received a task outside internal analysis');
  if (body.reasoning?.effort !== 'high') throw new Error('Selected API reasoning effort was downgraded');
  const input=body.input ?? [];
  const output=[...input].reverse().find(x=>x.type==='function_call_output');
  let last=null;
  if(output) {try {last=typeof output.output==='string'?JSON.parse(output.output):output.output;}catch{}}
  if(last?.error) throw new Error(`Host tool failed: ${JSON.stringify(last)}`);
  let next;
  if(!last) {units.set(unit,{receipts:[],reference:null});next=tool('read_analysis_unit',{});}
  else if(last.kind && last.required_inspection) {
    units.set(unit,{receipts:[],reference:null});
    if(last.kind==='text') next=tool('publish_analysis_unit',{receipts:[last.receipt_id],findings:[{kind:'statement',title:'Synthetic reported bag',text:'The synthetic witness statement reports a blue bag; the clock remains uncertain.',supporting:[last.input.ref_id],contrary:[],assessment:'attributed',data_json:JSON.stringify({object:'blue bag',clock_alignment:'unverified'})}]});
    else next=tool('query_case_knowledge',{query:'',offset:0});
  } else if(Array.isArray(last.items)) {
    const state=units.get(unit);state.receipts.push(last.receipt_id);state.reference ??= last.items[0]?.evidence[0]?.ref_id;
    if(last.next_offset!=null) next=tool('query_case_knowledge',{query:'',offset:last.next_offset});
    else next=tool('publish_analysis_unit',{receipts:state.receipts,findings:state.reference?[{kind:'claim',title:'Synthetic reconciled bag',text:'The synthetic witness statement reports a blue bag; the clock remains uncertain.',supporting:[state.reference],contrary:[],assessment:'attributed',data_json:JSON.stringify({object:'blue bag',clock_alignment:'unverified'})}]:[]});
  } else if(last.status==='analysis_published') next=tool('finish_analysis_unit',{reviews:last.objects.map(o=>({object_id:o.id,revision:o.revision,state:'supported',reason:'The exact synthetic source says a blue bag was reported and clock alignment remains uncertain.'}))});
  else throw new Error(`Unexpected analysis result: ${JSON.stringify(last)}`);
  calls.push(next.name);
  response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
  response.end(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:5},output:[next]}})}\n\n`);
}
http.createServer((request,response)=>{
  response.setHeader('access-control-allow-origin','*');response.setHeader('access-control-allow-methods','GET, POST, OPTIONS');
  if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
  if(request.url==='/state'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({requests,held:held.length,calls,errors}));return;}
  if(request.url==='/hold'){hold=true;response.end('held');return;}
  if(request.url==='/release'){hold=false;for(const [pending,body] of held.splice(0))if(!pending.destroyed)respond(pending,body);response.end('released');return;}
  if(request.url!=='/v1/responses' || request.method!=='POST'){response.writeHead(404);response.end();return;}
  let raw='';request.on('data',chunk=>{raw+=chunk;if(raw.length>16*1024*1024)request.destroy();});
  request.on('end',()=>{try{const body=JSON.parse(raw);if(hold)held.push([response,body]);else respond(response,body);}catch(error){errors.push(String(error));response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:String(error)}));}});
}).listen(port,'127.0.0.1');
