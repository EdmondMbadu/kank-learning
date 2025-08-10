import { Component, OnInit } from '@angular/core';
import { Student } from 'src/app/model/student';
import { AuthService } from 'src/app/shared/auth.service';
import { DataService } from 'src/app/shared/data.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnInit{

  studentList: Student[]=[];
  studentObj: Student = {
    id:'',
    first_name: '',
    last_name:'',
    email: '',
    mobile: '',
  
  }
  id:string ='';
  first_name: string = '';
  last_name: string = '';
  email: string = '';
  mobile: string = '';


  constructor(private auth:AuthService, private data: DataService){}

ngOnInit():void{
  this.getAllStudents();
}

  // logout(){
  //   this.auth.logout();

  // }

  getAllStudents(){
    this.data.getAllStudents().subscribe(res => {
      this.studentList = res.map(( e:any)=>{
        const data = e.payload.doc.data();
        data.id = e.payload.doc.id;
        return data;

      })

    },err=>{
      alert("Error while fetching the student data");
    })
  }

  resetForm(){

  this.id='';
  this.first_name= '';
  this.last_name= '';
  this.email= '';
  this.mobile = '';
  }
  addStudent(){
    if(this.first_name == '' || this.last_name =='' || this.mobile=='' || this.email=='' ){
      alert("Fill all input fields");
      return
    }
    this.studentObj.id = '';
    this.studentObj.email= this.email;
    this.studentObj.first_name = this.first_name;
    this.studentObj.last_name = this.last_name;
    this.studentObj.mobile = this.mobile;
    
    this.data.addStudent(this.studentObj); 
    this.resetForm()

  }
  updateStudent(student:Student){

  }
  deleteStudent(student: Student){

    if(window.confirm('Are you sure you want to delete '+student.first_name+' '+student.last_name)){

      this.data.deleteStudent(student);
    }
  

  }
}
