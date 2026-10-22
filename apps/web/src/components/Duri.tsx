import portrait from '../assets/duri-neutral.png';
export default function Duri({size=72}:{size?:number}){
 return <img src={portrait} alt="두리, 파란 해마" width={size} height={size} className="ee-duri" draggable={false}/>;
}
